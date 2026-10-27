// Чтение текста: PaddleOCR (PP-OCRv5, модель «русский+английский») через onnxruntime-node.
// Кадр отдаётся модели холстом прямо из сырых пикселей — без кодирования и декодирования PNG.
//   ocr(frame)              → { W, H, words: [{ text, box:[x,y,w,h], conf }] }  поиск + чтение
//   detectBoxes(frame)      → { W, H, boxes: [{ box }] }                        только поиск (~в 6 раз дешевле)
//   readRegion(frame, box)  → { lines, words } в координатах кадра             чтение одной области (с увеличением)
import { createCanvas } from "@napi-rs/canvas";
import { PaddleOcrService, V5_ESLAV_MOBILE_MODEL } from "ppu-paddle-ocr";
import { PNG } from "pngjs";

// если основной источник моделей недоступен — библиотека сама попробует зеркало на GitHub
process.env.PPU_PADDLE_OCR_MODEL_MIRROR ??= "1";

let svc = null;
function service() {
  if (!svc) {
    const s = new PaddleOcrService({ model: V5_ESLAV_MOBILE_MODEL });
    svc = { s, ready: s.initialize() };
  }
  return svc;
}
export const warmup = () => service().ready;

// кадр { W, H, data:RGBA } (или PNG-буфер) → холст
function toCanvas(src) {
  const f = src && src.data && src.W ? src : (() => { const p = PNG.sync.read(src); return { W: p.width, H: p.height, data: p.data }; })();
  const c = createCanvas(f.W, f.H);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(f.W, f.H);
  img.data.set(f.data);
  ctx.putImageData(img, 0, 0);
  return { c, f, W: f.W, H: f.H };
}

// ПАМЯТЬ ПРОЧИТАННОГО. Текст на экране нарисован системой: одна и та же строка — это одни и те же пиксели.
// Поэтому у каждого найденного куска текста считаем отпечаток пикселей и модель читает только куски
// с НОВЫМ отпечатком. После первого взгляда почти всё берётся из памяти (прокрутка сдвигает строки,
// но сами строки остаются теми же пикселями). Чтение — ~85–90% времени разбора, так что это главный рычаг.
const memo = new Map();
const MEMO_MAX = 20000;
export const memoStats = { hit: 0, miss: 0 };

// Отпечаток должен зависеть от ТЕКСТА, а не от рамки: рамку ищут на уменьшенной картинке (гуляет на пиксель)
// и раздувают полями (0.4 высоты строки сверху/снизу, 0.6 по бокам), которые залезают на соседние строки.
// Поэтому: снимаем поля → ядро строки → срезаем пустые края → добираем торчащие штрихи (хвосты, точки над ё)
// → хешируем ровно эти пиксели. Сдвиг рамки или перемена у соседей отпечаток не меняют.
function inkBox(f, px, b) {
  const W = f.W, H = f.H;
  const core = Math.max(1, Math.round(b.height / 1.8)), pv = Math.round(core * 0.4), ph = Math.round(core * 0.6);
  let x0 = Math.max(0, (b.x + ph) | 0), x1 = Math.min(W, (b.x + b.width - ph) | 0);
  let y0 = Math.max(0, (b.y + pv) | 0), y1 = Math.min(H, (b.y + b.height - pv) | 0);
  if (x1 - x0 < 2 || y1 - y0 < 2) { x0 = Math.max(0, b.x | 0); x1 = Math.min(W, (b.x + b.width) | 0); y0 = Math.max(0, b.y | 0); y1 = Math.min(H, (b.y + b.height) | 0); }
  // фон = самый частый цвет на верхней и нижней кромке раздутой рамки
  const cnt = new Map(), top = Math.max(0, b.y | 0), bot = Math.min(H - 1, (b.y + b.height - 1) | 0);
  for (const y of [top, bot]) for (let x = x0; x < x1; x += 2) { const v = px[y * W + x] & 0xffffff; cnt.set(v, (cnt.get(v) || 0) + 1); }
  let bg = 0, bc = -1; for (const [v, c] of cnt) if (c > bc) { bc = c; bg = v; }
  const br = bg & 255, bgG = (bg >> 8) & 255, bb = (bg >> 16) & 255;
  const ink = (v) => Math.abs((v & 255) - br) > 40 || Math.abs(((v >> 8) & 255) - bgG) > 40 || Math.abs(((v >> 16) & 255) - bb) > 40;
  const rowInk = (y) => { const r = y * W; for (let x = x0; x < x1; x++) if (ink(px[r + x])) return true; return false; };
  const colInk = (x) => { for (let y = y0; y < y1; y++) if (ink(px[y * W + x])) return true; return false; };
  while (y0 < y1 - 1 && !rowInk(y0)) y0++;
  while (y1 - 1 > y0 && !rowInk(y1 - 1)) y1--;
  for (let k = 0; k < pv && y0 > 0 && rowInk(y0 - 1); k++) y0--;
  for (let k = 0; k < pv && y1 < H && rowInk(y1); k++) y1++;
  while (x0 < x1 - 1 && !colInk(x0)) x0++;
  while (x1 - 1 > x0 && !colInk(x1 - 1)) x1--;
  for (let k = 0; k < ph && x0 > 0 && colInk(x0 - 1); k++) x0--;
  for (let k = 0; k < ph && x1 < W && colInk(x1); k++) x1++;
  return [x0, y0, x1, y1, core, bg];
}

function fingerprint(f, b) {
  const px = new Uint32Array(f.data.buffer, f.data.byteOffset, f.W * f.H);
  const [x0, y0, x1, y1, core, bg] = inkBox(f, px, b);
  // от куска почти ничего не осталось (обрывок рамки, пунктир) — такой отпечаток может совпасть у разных
  // мест экрана. Не запоминаем: читаем как есть, по исходной рамке.
  if ((y1 - y0) < 0.5 * core || (x1 - x0) * (y1 - y0) < 64) return { key: null, rec: b };
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9;            // два независимых хеша → совпадение случайно не бывает
  for (let y = y0; y < y1; y++) {
    const row = y * f.W;
    for (let x = x0; x < x1; x++) {
      const v = px[row + x];
      h1 = Math.imul(h1 ^ v, 0x01000193);
      h2 = Math.imul(h2 ^ (v >>> 7 | v << 25), 0x85ebca6b) + (y - y0);
    }
  }
  // читать будем ровно эти пиксели на чистом фоне их цвета (см. strip) — поэтому цвет фона тоже в отпечатке
  return { key: `${x1 - x0}x${y1 - y0}:${bg.toString(36)}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`, ink: [x0, y0, x1, y1], bg };
}

// Незнакомый кусок → свой маленький холст: текст, вырезанный по самим пикселям, на чистом фоне своего цвета
// с ровными полями (как у библиотеки: 0.4 высоты сверху/снизу, 0.6 по бокам). Модель видит только текст —
// без обрывков соседних строк и без влияния размера общей картинки (на общей полосе ~3% кусков читались
// чуть иначе) → результат — функция одного отпечатка: память = чтение с нуля, пиксель в пиксель.
function pieceCanvas(f, px, it) {
  const [x0, y0, x1, y1] = it.ink, w = x1 - x0, h = y1 - y0;
  const pv = Math.max(2, Math.round(h * 0.4)), ph = Math.max(2, Math.round(h * 0.6));
  const sw = w + 2 * ph, sh = h + 2 * pv;
  if (sw > 1900 || sh > 1900) return null;           // библиотека уменьшила бы — читаем по исходной рамке
  const c = createCanvas(sw, sh), ctx = c.getContext("2d"), img = ctx.createImageData(sw, sh);
  const d = new Uint32Array(img.data.buffer);
  d.fill((it.bg & 0xffffff) | 0xff000000);
  for (let y = y0; y < y1; y++) d.set(px.subarray(y * f.W + x0, y * f.W + x1), (pv + y - y0) * sw + ph);
  ctx.putImageData(img, 0, 0);
  return { c, box: { x: 0, y: 0, width: sw, height: sh } };
}

// прочитать набор рамок на холсте поштучно; вернуть {text,conf}|null для каждой рамки по порядку
async function readBoxes(s, canvas, boxes) {
  if (!boxes.length) return [];
  const dict = (s.options.recognition || {}).charactersDictionary;
  const res = await s.recognitor.run(canvas, boxes, dict, "per-box", {});
  const got = new Array(boxes.length).fill(null);
  for (const r of res) {                            // результат → своя рамка по наибольшему перекрытию
    let best = -1, bi = 0;
    boxes.forEach((b, i) => { const v = iou(r.box, b); if (v > bi) { bi = v; best = i; } });
    if (best >= 0 && bi > 0.5) got[best] = { text: r.text, conf: r.confidence };
  }
  return got;
}

const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const i = ix * iy; return i / (a.width * a.height + b.width * b.height - i + 1e-9);
};

export async function ocr(frame, { memory = true } = {}) {
  const { s, ready } = service(); await ready;
  const { c, f, W, H } = toCanvas(frame);
  const boxes = (await s.detector.run(c)).filter((b) => b.width > 0 && b.height > 0);
  const fps = boxes.map((b) => fingerprint(f, b));
  // одинаковые куски на одном экране (повторяющиеся подписи) читаем один раз; куски без надёжного
  // отпечатка (key=null) — каждый отдельно, по исходной рамке и без запоминания
  const todo = new Map(), raw = [];
  fps.forEach((fp, i) => {
    if (!fp.key) { fp.key = `once:${i}`; raw.push({ key: fp.key, box: fp.rec }); memoStats.miss++; return; }
    if (memory && memo.has(fp.key)) memoStats.hit++; else if (!todo.has(fp.key)) { todo.set(fp.key, fp); memoStats.miss++; }
  });
  const store = (k, v) => memo.set(k, v || { text: "", conf: 0 });   // отброшенное моделью — пустым, чтобы не перечитывать
  const px = new Uint32Array(f.data.buffer, f.data.byteOffset, f.W * f.H);
  for (const fp of todo.values()) {
    const pc = pieceCanvas(f, px, fp);
    if (!pc) { raw.push({ key: fp.key, box: boxes[fps.indexOf(fp)] }); continue; }
    store(fp.key, (await readBoxes(s, pc.c, [pc.box]))[0]);
  }
  if (raw.length) { const got = await readBoxes(s, c, raw.map((r) => r.box)); raw.forEach((r, i) => store(r.key, got[i])); }
  for (const k of memo.keys()) { if (memo.size <= MEMO_MAX) break; memo.delete(k); }   // старые — вон
  const words = [];
  boxes.forEach((b, i) => {
    const k = fps[i].key, m = memo.get(k);
    if (k.startsWith("once:")) memo.delete(k);       // одноразовые не храним
    if (m && m.text) words.push({ text: m.text, box: [b.x | 0, b.y | 0, b.width | 0, b.height | 0], conf: Math.round((m.conf || 0) * 100) });
  });
  return { W, H, lines: [], words };
}

export async function detectBoxes(frame) {
  const { s, ready } = service(); await ready;
  const { c, W, H } = toCanvas(frame);
  const boxes = await s.detector.run(c);
  return { W, H, boxes: boxes.map((b) => ({ box: [b.x | 0, b.y | 0, b.width | 0, b.height | 0] })) };
}

// вырезать область кадра и увеличить (ближайший сосед) — мелкий экранный текст читается увереннее
export function cropScale(f, [x, y, w, h], scale = 1) {
  x = Math.max(0, x | 0); y = Math.max(0, y | 0); w = Math.min(f.W - x, w | 0); h = Math.min(f.H - y, h | 0);
  const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
  const data = new Uint8Array(cw * ch * 4), src = new Uint32Array(f.data.buffer, f.data.byteOffset, f.W * f.H), dst = new Uint32Array(data.buffer);
  const xs = new Int32Array(cw); for (let ox = 0; ox < cw; ox++) xs[ox] = x + Math.min(w - 1, (ox / scale) | 0);
  for (let oy = 0; oy < ch; oy++) {
    const row = (y + Math.min(h - 1, (oy / scale) | 0)) * f.W, o = oy * cw;
    for (let ox = 0; ox < cw; ox++) dst[o + ox] = src[row + xs[ox]];
  }
  const back = (b) => [Math.round(b[0] / scale) + x, Math.round(b[1] / scale) + y, Math.round(b[2] / scale), Math.round(b[3] / scale)];
  return { frame: { W: cw, H: ch, data }, back };
}

// прочитать область: слова в координатах исходного кадра + строки (слова, склеенные по высоте)
export async function readRegion(frame, box, { scale = 1.5 } = {}) {
  const { frame: crop, back } = cropScale(frame, box, scale);
  const r = await ocr(crop);
  const words = r.words.map((w) => ({ ...w, box: back(w.box) })).sort((a, b) => (a.box[1] - b.box[1]) || (a.box[0] - b.box[0]));
  const lines = [];
  for (const w of words) {
    const mid = w.box[1] + w.box[3] / 2;
    const l = lines.find((L) => Math.abs(L.mid - mid) < 0.5 * Math.max(L.h, w.box[3]));
    if (l) { l.words.push(w); l.mid = (l.mid + mid) / 2; } else lines.push({ mid, h: w.box[3], words: [w] });
  }
  return {
    words,
    lines: lines.map((l) => {
      l.words.sort((a, b) => a.box[0] - b.box[0]);
      const x0 = Math.min(...l.words.map((w) => w.box[0])), y0 = Math.min(...l.words.map((w) => w.box[1]));
      const x1 = Math.max(...l.words.map((w) => w.box[0] + w.box[2])), y1 = Math.max(...l.words.map((w) => w.box[1] + w.box[3]));
      return { text: l.words.map((w) => w.text).join(" "), box: [x0, y0, x1 - x0, y1 - y0] };
    }),
  };
}
