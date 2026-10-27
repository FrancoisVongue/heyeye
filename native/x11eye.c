// x11eye — постоянный процесс-помощник: глаза и руки агента на X11-экране.
//
//   Глаза: кадр через общую память X (MIT-SHM) — без файлов, без PNG, единицы миллисекунд.
//   Изменения: расширение DAMAGE — X-сервер сам сообщает, какие прямоугольники перерисовались.
//              Отсюда «что изменилось после действия» и «экран успокоился» без сравнения кадров.
//   Руки: расширение XTEST — нажатия неотличимы от настоящих. Ввод текста не зависит от раскладки:
//         символ, которого нет на клавиатуре (кириллица при английской раскладке и т.п.),
//         временно назначается на свободную клавишу.
//
// Протокол: одна команда = одна строка в stdin. Ответ: "OK <n>\n" + n байт, или "ER <n>\n" + текст ошибки.
//   info                         → "W H"
//   cap [x y w h]                → RGBA, w*h*4 байт (без аргументов — весь экран)
//   capf [x y w h]               → то же, но RGBA кладётся в файл кадра (аргумент запуска), ответ "w h"
//   reset                        → забыть накопленные изменения
//   changes QUIET FIRST TIMEOUT  → ждать, пока экран не успокоится:
//                                  QUIET мс без перерисовок; если перерисовок не было вовсе — ждём их FIRST мс;
//                                  не дольше TIMEOUT мс. Ответ: "settled waited_ms n redrawn\n" + n строк "x y w h" —
//                                  точные границы реально изменившихся пикселей (redrawn — сколько мест перерисовали)
//   move X Y | down B | up B | click B N [X Y] | wheel DX DY | drag X1 Y1 X2 Y2 STEPS
//   key COMBO [down|up]          → "ctrl+shift+t", "Return", "a" (без down/up — нажать и отпустить)
//   type HEX                     → набрать текст (UTF-8 в шестнадцатеричном виде)
//   ptr                          → "X Y"
//   wins                         → строки "id x y w h имя" (снизу вверх по стопке окон)
//
// Сборка: cc -O2 -o native/x11eye native/x11eye.c -lX11 -lXext -lXtst -lXdamage
#define _GNU_SOURCE
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/keysym.h>
#include <X11/extensions/XShm.h>
#include <X11/extensions/XTest.h>
#include <X11/extensions/Xdamage.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <poll.h>
#include <time.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <stdint.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/mman.h>

static Display *dpy;
static Window root;
static int W, H;
static Visual *vis;
static int depth;
static XShmSegmentInfo shm;
static uint8_t *out;          // буфер ответа для кадра (RGBA)

// ---------- ответы ----------
static void reply(const char *tag, const void *data, size_t n) {
  printf("%s %zu\n", tag, n);
  if (n) fwrite(data, 1, n, stdout);
  fflush(stdout);
}
static void ok_text(const char *s) { reply("OK", s, strlen(s)); }
static void err(const char *s) { reply("ER", s, strlen(s)); }

static double now_ms(void) {
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

// ---------- кадр ----------
// tofile=1: кадр кладётся в общий файл в памяти (/dev/shm, путь — первый аргумент), в ответе только "w h".
// Читающая сторона забирает его одним копированием — без прокачки мегабайт через канал.
static uint8_t *outfile;
static void capture(int x, int y, int w, int h, int tofile) {
  uint8_t *dst = tofile ? outfile : out;
  if (!dst) { err("файл кадра не задан"); return; }
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x + w > W) w = W - x;
  if (y + h > H) h = H - y;
  if (w <= 0 || h <= 0) { err("пустая область"); return; }
  // XImage поверх того же сегмента общей памяти, размером ровно с область
  XImage *img = XShmCreateImage(dpy, vis, depth, ZPixmap, shm.shmaddr, &shm, w, h);
  if (!img || !XShmGetImage(dpy, root, img, x, y, AllPlanes)) { if (img) { img->data = NULL; XDestroyImage(img); } err("XShmGetImage"); return; }
  // BGRX (порядок байт X на little-endian) → RGBA. Плотный цикл, компилятор векторизует.
  const int bpl = img->bytes_per_line;
  for (int r = 0; r < h; r++) {
    const uint8_t *s = (const uint8_t *)img->data + (size_t)r * bpl;
    uint8_t *d = dst + (size_t)r * w * 4;
    for (int c = 0; c < w; c++, s += 4, d += 4) { d[0] = s[2]; d[1] = s[1]; d[2] = s[0]; d[3] = 255; }
  }
  img->data = NULL; XDestroyImage(img);
  if (tofile) { char b[32]; snprintf(b, sizeof b, "%d %d", w, h); ok_text(b); }
  else reply("OK", out, (size_t)w * h * 4);
}

// ---------- изменения (DAMAGE) ----------
static int dmg_event_base;
typedef struct { int x, y, w, h; } Rect;
#define MAXR 4096
static Rect rects[MAXR];
static int nrects;
static double last_damage;    // время последней значимой перерисовки

// мелочь вроде мигающей каретки (1–3 px шириной) не считаем изменением экрана
static int trivial(int w, int h) { return (w <= 3 || h <= 3) && w * h <= 3 * 64; }

static void add_rect(int x, int y, int w, int h) {
  if (trivial(w, h)) return;
  last_damage = now_ms();
  // сразу сливаем с пересекающимся/соседним (зазор 4 px) — список не разрастается
  for (int i = 0; i < nrects; i++) {
    Rect *r = &rects[i];
    if (x <= r->x + r->w + 4 && r->x <= x + w + 4 && y <= r->y + r->h + 4 && r->y <= y + h + 4) {
      int x0 = x < r->x ? x : r->x, y0 = y < r->y ? y : r->y;
      int x1 = x + w > r->x + r->w ? x + w : r->x + r->w, y1 = y + h > r->y + r->h ? y + h : r->y + r->h;
      r->x = x0; r->y = y0; r->w = x1 - x0; r->h = y1 - y0;
      return;
    }
  }
  if (nrects < MAXR) { rects[nrects++] = (Rect){x, y, w, h}; return; }
  // переполнение: всё в один общий прямоугольник
  int x0 = x, y0 = y, x1 = x + w, y1 = y + h;
  for (int i = 0; i < nrects; i++) {
    if (rects[i].x < x0) x0 = rects[i].x;
    if (rects[i].y < y0) y0 = rects[i].y;
    if (rects[i].x + rects[i].w > x1) x1 = rects[i].x + rects[i].w;
    if (rects[i].y + rects[i].h > y1) y1 = rects[i].y + rects[i].h;
  }
  nrects = 1; rects[0] = (Rect){x0, y0, x1 - x0, y1 - y0};
}

// после слияния по ходу дела прямоугольники могли начать пересекаться — доводим до неподвижной точки
static void merge_all(void) {
  for (int changed = 1; changed;) {
    changed = 0;
    for (int i = 0; i < nrects; i++) for (int j = i + 1; j < nrects; j++) {
      Rect *a = &rects[i], *b = &rects[j];
      if (a->x <= b->x + b->w + 4 && b->x <= a->x + a->w + 4 && a->y <= b->y + b->h + 4 && b->y <= a->y + a->h + 4) {
        int x0 = a->x < b->x ? a->x : b->x, y0 = a->y < b->y ? a->y : b->y;
        int x1 = a->x + a->w > b->x + b->w ? a->x + a->w : b->x + b->w;
        int y1 = a->y + a->h > b->y + b->h ? a->y + a->h : b->y + b->h;
        *a = (Rect){x0, y0, x1 - x0, y1 - y0};
        *b = rects[--nrects]; j--; changed = 1;
      }
    }
  }
}

static void pump(int timeout_ms) {
  if (!XPending(dpy) && timeout_ms > 0) {
    struct pollfd p = {ConnectionNumber(dpy), POLLIN, 0};
    poll(&p, 1, timeout_ms);
  }
  while (XPending(dpy)) {
    XEvent e; XNextEvent(dpy, &e);
    if (e.type == dmg_event_base + XDamageNotify) {
      XDamageNotifyEvent *d = (XDamageNotifyEvent *)&e;
      add_rect(d->area.x, d->area.y, d->area.width, d->area.height);
    } else if (e.type == MappingNotify) {
      XRefreshKeyboardMapping(&e.xmapping);
    }
  }
}

// ---------- копия экрана и ТОЧНЫЕ изменения ----------
// DAMAGE говорит, ГДЕ программа перерисовывала, но программы перерисовывают щедро (Chrome — одним большим
// прямоугольником на всё обновление). Поэтому храним копию экрана: снимаем только перерисованные области,
// сравниваем с копией по клеткам TS×TS и получаем границы РЕАЛЬНО изменившихся пикселей. Копия тут же
// обновляется — значит, следующий ответ снова «относительно прошлого раза».
#define TS 8
static uint32_t *base;        // экран на момент последнего reset/changes, пиксели как в X (BGRX)
static int TW, TH;            // размер сетки клеток
static int *cx0, *cy0, *cx1, *cy1;   // границы изменившихся пикселей в клетке (cx0 > cx1 — клетка не менялась)
static Rect found[MAXR];
static int nfound;

static void sync_rect(Rect r, int diff) {
  int x = r.x, y = r.y, w = r.w, h = r.h;
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (x + w > W) w = W - x;
  if (y + h > H) h = H - y;
  if (w <= 0 || h <= 0) return;
  XImage *img = XShmCreateImage(dpy, vis, depth, ZPixmap, shm.shmaddr, &shm, w, h);
  if (!img) return;
  if (XShmGetImage(dpy, root, img, x, y, AllPlanes)) {
    for (int j = 0; j < h; j++) {
      const uint32_t *s = (const uint32_t *)(img->data + (size_t)j * img->bytes_per_line);
      uint32_t *d = base + (size_t)(y + j) * W + x;
      if (diff) {
        const int py = y + j, trow = (py / TS) * TW;
        for (int i = 0; i < w; i++) {
          if (((s[i] ^ d[i]) & 0xffffff) == 0) continue;
          const int px = x + i, t = trow + px / TS;
          if (px < cx0[t]) cx0[t] = px;
          if (px > cx1[t]) cx1[t] = px;
          if (py < cy0[t]) cy0[t] = py;
          if (py > cy1[t]) cy1[t] = py;
        }
      }
      memcpy(d, s, (size_t)w * 4);
    }
  }
  img->data = NULL; XDestroyImage(img);
}

static void clear_tiles(void) {
  for (int t = 0; t < TW * TH; t++) { cx0[t] = cy0[t] = 1 << 30; cx1[t] = cy1[t] = -1; }
}

// изменившиеся клетки → связные группы (8 соседей) → прямоугольник по точным границам пикселей
static void collect(void) {
  static int *stack, *seen;
  if (!stack) { stack = malloc(sizeof(int) * TW * TH); seen = calloc(TW * TH, sizeof(int)); }
  static int stamp;
  stamp++;
  nfound = 0;
  for (int t0 = 0; t0 < TW * TH; t0++) {
    if (cx1[t0] < 0 || seen[t0] == stamp) continue;
    int sp = 0, x0 = 1 << 30, y0 = 1 << 30, x1 = -1, y1 = -1;
    stack[sp++] = t0; seen[t0] = stamp;
    while (sp) {
      int t = stack[--sp], tx = t % TW, ty = t / TW;
      if (cx0[t] < x0) x0 = cx0[t];
      if (cy0[t] < y0) y0 = cy0[t];
      if (cx1[t] > x1) x1 = cx1[t];
      if (cy1[t] > y1) y1 = cy1[t];
      for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
        int nx = tx + dx, ny = ty + dy;
        if (nx < 0 || ny < 0 || nx >= TW || ny >= TH) continue;
        int n = ny * TW + nx;
        if (cx1[n] >= 0 && seen[n] != stamp) { seen[n] = stamp; stack[sp++] = n; }
      }
    }
    int w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w <= 2 && h <= 40) continue;   // мигающая каретка в поле ввода — не изменение
    if (nfound < MAXR) found[nfound++] = (Rect){x0, y0, w, h};
  }
  clear_tiles();
}

static void init_base(void) {
  base = malloc((size_t)W * H * 4);
  TW = (W + TS - 1) / TS; TH = (H + TS - 1) / TS;
  cx0 = malloc(sizeof(int) * TW * TH); cy0 = malloc(sizeof(int) * TW * TH);
  cx1 = malloc(sizeof(int) * TW * TH); cy1 = malloc(sizeof(int) * TW * TH);
  clear_tiles();
  sync_rect((Rect){0, 0, W, H}, 0);
}

// забыть накопленное: копия = текущий экран (досинхронизируем только перерисованные места)
static void reset(void) {
  XSync(dpy, False); pump(0);
  merge_all();
  for (int i = 0; i < nrects; i++) sync_rect(rects[i], 0);
  nrects = 0;
}

static void changes(int quiet, int first, int timeout) {
  double t0 = now_ms();
  XSync(dpy, False);
  pump(0);
  int settled = 0;
  for (;;) {
    double t = now_ms();
    if (nrects > 0 && t - last_damage >= quiet && t - t0 >= quiet) { settled = 1; break; }
    if (nrects == 0 && t - t0 >= (first > quiet ? first : quiet)) { settled = 1; break; }
    if (t - t0 >= timeout) break;
    pump(5);
  }
  merge_all();
  for (int i = 0; i < nrects; i++) sync_rect(rects[i], 1);
  int redrawn = nrects;
  nrects = 0;
  collect();
  static char buf[MAXR * 48 + 64];
  int n = snprintf(buf, sizeof buf, "%d %d %d %d\n", settled, (int)(now_ms() - t0), nfound, redrawn);
  for (int i = 0; i < nfound; i++) n += snprintf(buf + n, sizeof buf - n, "%d %d %d %d\n", found[i].x, found[i].y, found[i].w, found[i].h);
  reply("OK", buf, n);
}

// ---------- клавиатура ----------
static int kmin, kmax, kper;
static KeySym *kmap;          // копия раскладки: kper символов на клавишу
static KeyCode spare[64];     // свободные клавиши (без символов) — для символов, которых нет на клавиатуре
static KeySym spare_ks[64];
static int nspare, spare_next;

static void load_map(void) {
  if (kmap) XFree(kmap);
  kmap = XGetKeyboardMapping(dpy, kmin, kmax - kmin + 1, &kper);
}

static void init_keys(void) {
  XDisplayKeycodes(dpy, &kmin, &kmax);
  load_map();
  for (int kc = kmax; kc >= kmin && nspare < 64; kc--) {
    int empty = 1;
    for (int l = 0; l < kper; l++) if (kmap[(kc - kmin) * kper + l] != NoSymbol) { empty = 0; break; }
    if (empty) spare[nspare++] = kc;
  }
}

// символ Unicode → KeySym (Latin-1 совпадает с кодом, остальное — диапазон 0x01000000)
static KeySym ks_of(uint32_t cp) {
  if (cp == '\n' || cp == '\r') return XK_Return;
  if (cp == '\t') return XK_Tab;
  if (cp == 8) return XK_BackSpace;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return 0x01000000 | cp;
}

// найти клавишу для символа: на первом уровне (без Shift) или на втором (с Shift) первой группы.
// Нет — назначаем символ на свободную клавишу (переиспользуем, если уже назначали).
static int key_for(KeySym ks, KeyCode *kc, int *shift) {
  for (int c = kmin; c <= kmax; c++) {
    KeySym *k = &kmap[(c - kmin) * kper];
    if (k[0] == ks) { *kc = c; *shift = 0; return 1; }
    if (kper > 1 && k[1] == ks) { *kc = c; *shift = 1; return 1; }
  }
  for (int i = 0; i < nspare; i++) if (spare_ks[i] == ks) { *kc = spare[i]; *shift = 0; return 1; }
  if (!nspare) return 0;
  int i = spare_next++ % nspare;
  KeySym pair[2] = {ks, ks};
  XChangeKeyboardMapping(dpy, spare[i], 2, pair, 1);
  XSync(dpy, False);
  spare_ks[i] = ks;
  // получатели обновляют раскладку по MappingNotify; даём им мгновение до первого нажатия
  usleep(20000);
  *kc = spare[i]; *shift = 0;
  return 1;
}

static KeyCode kc_shift;

static void tap(KeyCode kc, int shift) {
  if (shift) XTestFakeKeyEvent(dpy, kc_shift, True, 0);
  XTestFakeKeyEvent(dpy, kc, True, 0);
  XTestFakeKeyEvent(dpy, kc, False, 0);
  if (shift) XTestFakeKeyEvent(dpy, kc_shift, False, 0);
}

static uint32_t utf8_next(const uint8_t **p) {
  const uint8_t *s = *p; uint32_t c = *s++;
  if (c >= 0xf0) { c = (c & 7) << 18 | (s[0] & 63) << 12 | (s[1] & 63) << 6 | (s[2] & 63); s += 3; }
  else if (c >= 0xe0) { c = (c & 15) << 12 | (s[0] & 63) << 6 | (s[1] & 63); s += 2; }
  else if (c >= 0xc0) { c = (c & 31) << 6 | (s[0] & 63); s += 1; }
  *p = s; return c;
}

static void type_text(const uint8_t *s) {
  while (*s) {
    uint32_t cp = utf8_next(&s);
    KeyCode kc; int sh;
    if (key_for(ks_of(cp), &kc, &sh)) tap(kc, sh);
  }
  XSync(dpy, False);
  ok_text("");
}

static KeySym ks_name(const char *n) {
  static const struct { const char *a, *b; } alias[] = {
    {"ctrl", "Control_L"}, {"control", "Control_L"}, {"shift", "Shift_L"}, {"alt", "Alt_L"},
    {"super", "Super_L"}, {"win", "Super_L"}, {"cmd", "Super_L"}, {"meta", "Super_L"},
    {"enter", "Return"}, {"return", "Return"}, {"esc", "Escape"}, {"escape", "Escape"},
    {"tab", "Tab"}, {"space", "space"}, {"backspace", "BackSpace"}, {"delete", "Delete"}, {"del", "Delete"},
    {"up", "Up"}, {"down", "Down"}, {"left", "Left"}, {"right", "Right"},
    {"pageup", "Prior"}, {"pgup", "Prior"}, {"pagedown", "Next"}, {"pgdn", "Next"},
    {"home", "Home"}, {"end", "End"}, {"insert", "Insert"},
  };
  for (size_t i = 0; i < sizeof alias / sizeof *alias; i++) if (!strcasecmp(n, alias[i].a)) n = alias[i].b;
  KeySym ks = XStringToKeysym(n);
  if (ks == NoSymbol) { const uint8_t *p = (const uint8_t *)n; uint32_t cp = utf8_next(&p); if (!*p) ks = ks_of(cp); }
  return ks;
}

// "ctrl+shift+t" [down|up]: модификаторы зажимаются, последняя клавиша нажимается
static void key_combo(char *combo, const char *mode) {
  KeyCode kcs[8]; int n = 0;
  for (char *tok = strtok(combo, "+"); tok && n < 8; tok = strtok(NULL, "+")) {
    KeySym ks = ks_name(tok); KeyCode kc; int sh;
    if (ks == NoSymbol || !key_for(ks, &kc, &sh)) { err("неизвестная клавиша"); return; }
    kcs[n++] = kc;
  }
  if (!n) { err("пустое сочетание"); return; }
  int down = !mode || !strcmp(mode, "down"), up = !mode || !strcmp(mode, "up");
  if (down) for (int i = 0; i < n; i++) XTestFakeKeyEvent(dpy, kcs[i], True, 0);
  if (up) for (int i = n - 1; i >= 0; i--) XTestFakeKeyEvent(dpy, kcs[i], False, 0);
  XSync(dpy, False);
  ok_text("");
}

// ---------- мышь ----------
static void move(int x, int y) { XTestFakeMotionEvent(dpy, -1, x, y, 0); }
static void button(int b, int press) { XTestFakeButtonEvent(dpy, b, press, 0); }

static void wheel(int dx, int dy) {
  for (int i = 0; i < abs(dy); i++) { button(dy > 0 ? 5 : 4, 1); button(dy > 0 ? 5 : 4, 0); }
  for (int i = 0; i < abs(dx); i++) { button(dx > 0 ? 7 : 6, 1); button(dx > 0 ? 7 : 6, 0); }
}

static void drag(int x1, int y1, int x2, int y2, int steps) {
  if (steps < 1) steps = 1;
  move(x1, y1); XSync(dpy, False);
  button(1, 1); XSync(dpy, False); usleep(30000);
  for (int i = 1; i <= steps; i++) {
    move(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
    XSync(dpy, False); usleep(4000);
  }
  usleep(30000);
  button(1, 0);
}

// ---------- окна ----------
static Atom a_net_name, a_utf8;

static int win_name(Window w, char *buf, size_t n, int depth_left) {
  // сначала современное имя в UTF-8 (_NET_WM_NAME), потом старое WM_NAME
  Atom type; int fmt; unsigned long cnt, after; unsigned char *prop = NULL;
  if (XGetWindowProperty(dpy, w, a_net_name, 0, 256, False, a_utf8, &type, &fmt, &cnt, &after, &prop) == Success && prop && cnt) {
    snprintf(buf, n, "%s", (char *)prop); XFree(prop); return 1;
  }
  if (prop) XFree(prop);
  char *name = NULL;
  if (XFetchName(dpy, w, &name) && name) { snprintf(buf, n, "%s", name); XFree(name); return 1; }
  if (!depth_left) return 0;
  Window r, p, *kids = NULL; unsigned nk = 0;
  if (!XQueryTree(dpy, w, &r, &p, &kids, &nk)) return 0;
  int found = 0;
  for (unsigned i = 0; i < nk && !found; i++) found = win_name(kids[i], buf, n, depth_left - 1);
  if (kids) XFree(kids);
  return found;
}

static void wins(void) {
  Window r, p, *kids = NULL; unsigned nk = 0;
  XQueryTree(dpy, root, &r, &p, &kids, &nk);
  static char buf[1 << 16]; int n = 0;
  for (unsigned i = 0; i < nk; i++) {
    XWindowAttributes a;
    if (!XGetWindowAttributes(dpy, kids[i], &a) || a.map_state != IsViewable || a.width <= 1 || a.height <= 1) continue;
    char name[256] = "";
    win_name(kids[i], name, sizeof name, 2);
    for (char *c = name; *c; c++) if (*c == '\n') *c = ' ';
    n += snprintf(buf + n, sizeof buf - n, "%lu %d %d %d %d %s\n", kids[i], a.x, a.y, a.width, a.height, name);
    if (n > (int)sizeof buf - 512) break;
  }
  if (kids) XFree(kids);
  reply("OK", buf, n);
}

// ---------- main ----------
static int hexval(int c) { return c <= '9' ? c - '0' : (c | 32) - 'a' + 10; }

int main(int argc, char **argv) {
  dpy = XOpenDisplay(NULL);
  if (!dpy) { fprintf(stderr, "x11eye: нет экрана (DISPLAY?)\n"); return 1; }
  int scr = DefaultScreen(dpy);
  root = RootWindow(dpy, scr);
  W = DisplayWidth(dpy, scr); H = DisplayHeight(dpy, scr);
  vis = DefaultVisual(dpy, scr); depth = DefaultDepth(dpy, scr);

  int ev, er, maj, min;
  if (!XShmQueryExtension(dpy)) { fprintf(stderr, "x11eye: нет MIT-SHM\n"); return 1; }
  if (!XTestQueryExtension(dpy, &ev, &er, &maj, &min)) { fprintf(stderr, "x11eye: нет XTEST\n"); return 1; }
  if (!XDamageQueryExtension(dpy, &dmg_event_base, &er)) { fprintf(stderr, "x11eye: нет DAMAGE\n"); return 1; }

  shm.shmid = shmget(IPC_PRIVATE, (size_t)W * H * 4, IPC_CREAT | 0600);
  shm.shmaddr = shmat(shm.shmid, NULL, 0);
  shm.readOnly = False;
  XShmAttach(dpy, &shm);
  XSync(dpy, False);
  shmctl(shm.shmid, IPC_RMID, NULL);   // сегмент удалится сам, когда отцепимся
  out = malloc((size_t)W * H * 4);
  if (argc > 1) {   // файл кадра в памяти: пишем сюда, читатель забирает одним копированием
    int fd = open(argv[1], O_RDWR | O_CREAT | O_TRUNC, 0600);
    if (fd < 0 || ftruncate(fd, (off_t)W * H * 4)) { fprintf(stderr, "x11eye: не открыть %s\n", argv[1]); return 1; }
    outfile = mmap(NULL, (size_t)W * H * 4, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    close(fd);
    if (outfile == MAP_FAILED) { fprintf(stderr, "x11eye: mmap\n"); return 1; }
  }

  a_net_name = XInternAtom(dpy, "_NET_WM_NAME", False);
  a_utf8 = XInternAtom(dpy, "UTF8_STRING", False);
  XDamageCreate(dpy, root, XDamageReportRawRectangles);
  init_keys();
  kc_shift = XKeysymToKeycode(dpy, XK_Shift_L);
  XSync(dpy, False);
  pump(0); nrects = 0;
  init_base();

  static char line[1 << 20];
  while (fgets(line, sizeof line, stdin)) {
    line[strcspn(line, "\n")] = 0;
    char cmd[16] = ""; int a[6] = {0}; int na;
    sscanf(line, "%15s", cmd);
    const char *rest = line + strlen(cmd); while (*rest == ' ') rest++;
    pump(0);   // по пути собираем накопившиеся перерисовки

    if (!strcmp(cmd, "info")) { char b[64]; snprintf(b, sizeof b, "%d %d", W, H); ok_text(b); }
    else if (!strcmp(cmd, "cap") || !strcmp(cmd, "capf")) {
      na = sscanf(rest, "%d %d %d %d", &a[0], &a[1], &a[2], &a[3]);
      int f = cmd[3] == 'f';
      if (na == 4) capture(a[0], a[1], a[2], a[3], f); else capture(0, 0, W, H, f);
    }
    else if (!strcmp(cmd, "reset")) { reset(); ok_text(""); }
    else if (!strcmp(cmd, "changes")) {
      a[0] = 150; a[1] = 400; a[2] = 3000;
      sscanf(rest, "%d %d %d", &a[0], &a[1], &a[2]);
      changes(a[0], a[1], a[2]);
    }
    else if (!strcmp(cmd, "move")) { sscanf(rest, "%d %d", &a[0], &a[1]); move(a[0], a[1]); XSync(dpy, False); ok_text(""); }
    else if (!strcmp(cmd, "down") || !strcmp(cmd, "up")) {
      a[0] = 1; sscanf(rest, "%d", &a[0]); button(a[0], cmd[0] == 'd'); XSync(dpy, False); ok_text("");
    }
    else if (!strcmp(cmd, "click")) {
      a[0] = 1; a[1] = 1;
      na = sscanf(rest, "%d %d %d %d", &a[0], &a[1], &a[2], &a[3]);
      if (na >= 4) { move(a[2], a[3]); XSync(dpy, False); }
      for (int i = 0; i < a[1]; i++) { button(a[0], 1); button(a[0], 0); XSync(dpy, False); if (i + 1 < a[1]) usleep(40000); }
      ok_text("");
    }
    else if (!strcmp(cmd, "wheel")) { sscanf(rest, "%d %d", &a[0], &a[1]); wheel(a[0], a[1]); XSync(dpy, False); ok_text(""); }
    else if (!strcmp(cmd, "drag")) {
      a[4] = 16; sscanf(rest, "%d %d %d %d %d", &a[0], &a[1], &a[2], &a[3], &a[4]);
      drag(a[0], a[1], a[2], a[3], a[4]); XSync(dpy, False); ok_text("");
    }
    else if (!strcmp(cmd, "key")) {
      char combo[256] = "", mode[8] = "";
      na = sscanf(rest, "%255s %7s", combo, mode);
      key_combo(combo, na >= 2 ? mode : NULL);
    }
    else if (!strcmp(cmd, "type")) {
      static uint8_t txt[1 << 19]; size_t n = 0;
      for (const char *h = rest; h[0] && h[1] && n < sizeof txt - 1; h += 2) txt[n++] = hexval(h[0]) << 4 | hexval(h[1]);
      txt[n] = 0;
      type_text(txt);
    }
    else if (!strcmp(cmd, "ptr")) {
      Window r, c; int rx, ry, wx, wy; unsigned m; char b[64];
      XQueryPointer(dpy, root, &r, &c, &rx, &ry, &wx, &wy, &m);
      snprintf(b, sizeof b, "%d %d", rx, ry); ok_text(b);
    }
    else if (!strcmp(cmd, "wins")) wins();
    else err("неизвестная команда");
  }
  // вернуть свободные клавиши как были
  KeySym none[2] = {NoSymbol, NoSymbol};
  for (int i = 0; i < nspare; i++) if (spare_ks[i]) XChangeKeyboardMapping(dpy, spare[i], 2, none, 1);
  XShmDetach(dpy, &shm);
  XCloseDisplay(dpy);
  return 0;
}
