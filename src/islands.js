// КОНТЕЙНЕРЫ = ОСТРОВА «НЕ-ФОНА», рекурсивно. CPU, без ML. Модель мышления юзера:
//   фон = самый частый цвет страницы. Всё, что не фон, — острова (карточки/панели/hero).
//   Текст/градиент внутри острова НЕ дробят его: важно лишь «не фон», а не похожесть цвета,
//   поэтому карточка(градиент+белое+текст) = ОДИН связный остров. Затем ЗАХОДИМ внутрь каждого
//   острова: там фон = его собственный цвет → находим вложенные (кнопки/картинки/подпанели).
import { PNG } from "pngjs";
import fs from "node:fs";

// ОДНО внутреннее представление кадра: декодируем PNG РАЗ → сырой RGBA. Дальше все стадии берут его,
// а не передекодируют картинку по 12 раз. cropFrame = срез буфера (фовеа без декода/энкода).
export function decodeFrame(buf) { const { width: W, height: H, data } = PNG.sync.read(buf); return { W, H, data }; }
export function cropFrame(f, x, y, bw, bh) { x = Math.max(0, x | 0); y = Math.max(0, y | 0); bw = Math.min(bw | 0, f.W - x); bh = Math.min(bh | 0, f.H - y); const out = new Uint8Array(bw * bh * 4); for (let yy = 0; yy < bh; yy++) { const so = ((y + yy) * f.W + x) * 4; out.set(f.data.subarray(so, so + bw * 4), yy * bw * 4); } return { W: bw, H: bh, data: out }; }
const asFrame = (src) => (src && src.data && src.W ? src : decodeFrame(src)); // принимаем кадр ИЛИ буфер

function loadScaled(src, maxW) {
  const { W, H, data } = asFrame(src);
  const s = Math.min(1, maxW / W), w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
  const px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (((y / s) | 0) * W + ((x / s) | 0)) * 4, j = (y * w + x) * 3; px[j] = data[i]; px[j + 1] = data[i + 1]; px[j + 2] = data[i + 2]; }
  return { px, w, h, s };
}
// «фон» уровня = самый частый цвет по РАМКЕ региона (backdrop/холст), а НЕ по всей площади:
// контент (белые карточки, лента) может занимать больше площади, чем сам фон, и тогда мода по площади
// ошибочно берёт белый. По краям же всегда backdrop. Квантование 5 бит.
function bgColor(px, w, h, x0, y0, x1, y1) {
  const hist = new Map(), t = 2;
  const add = (x, y) => { const j = (y * w + x) * 3; const key = ((px[j] >> 3) << 10) | ((px[j + 1] >> 3) << 5) | (px[j + 2] >> 3); hist.set(key, (hist.get(key) || 0) + 1); };
  for (let k = 0; k < t; k++) { for (let x = x0; x <= x1; x++) { add(x, Math.min(y1, y0 + k)); add(x, Math.max(y0, y1 - k)); } for (let y = y0; y <= y1; y++) { add(Math.min(x1, x0 + k), y); add(Math.max(x0, x1 - k), y); } }
  let bk = 0, bc = -1; for (const [key, c] of hist) if (c > bc) { bc = c; bk = key; }
  return [((bk >> 10) & 31) << 3, ((bk >> 5) & 31) << 3, (bk & 31) << 3];
}
const far = (px, j, bg, tol) => Math.max(Math.abs(px[j] - bg[0]), Math.abs(px[j + 1] - bg[1]), Math.abs(px[j + 2] - bg[2])) > tol;

// острова «не-фона» внутри [x0,y0,x1,y1] при данном bg; возвращает компоненты (bbox+маска-инфо)
function islandsIn(px, w, h, x0, y0, x1, y1, bg, tol, minArea, lab, stamp) {
  const out = [], q = [];
  for (let sy = y0; sy <= y1; sy++) for (let sx = x0; sx <= x1; sx++) {
    const s = sy * w + sx, sj = s * 3;
    if (lab[s] === stamp || !far(px, sj, bg, tol)) continue;
    lab[s] = stamp; let head = 0; q.length = 0; q.push(s);
    let ax0 = sx, ay0 = sy, ax1 = sx, ay1 = sy, area = 0;
    while (head < q.length) { const p = q[head++], pxx = p % w, pyy = (p / w) | 0; area++;
      if (pxx < ax0) ax0 = pxx; if (pxx > ax1) ax1 = pxx; if (pyy < ay0) ay0 = pyy; if (pyy > ay1) ay1 = pyy;
      const tryN = (n, nx, ny) => { if (nx < x0 || nx > x1 || ny < y0 || ny > y1) return; if (lab[n] !== stamp && far(px, n * 3, bg, tol)) { lab[n] = stamp; q.push(n); } };
      if (pxx + 1 <= x1) tryN(p + 1, pxx + 1, pyy); if (pxx - 1 >= x0) tryN(p - 1, pxx - 1, pyy);
      if (pyy + 1 <= y1) tryN(p + w, pxx, pyy + 1); if (pyy - 1 >= y0) tryN(p - w, pxx, pyy - 1);
    }
    if (area >= minArea && ax1 - ax0 > 5 && ay1 - ay0 > 5) out.push({ x0: ax0, y0: ay0, x1: ax1, y1: ay1, area });
  }
  return out;
}
// форма + признак КАРТИНКИ. Картинка (фото) = много разных цветов И высокая плотность краёв.
// Градиент карточки тоже многоцветный, но края ПЛАВНЫЕ (низкая плотность) → НЕ картинка. Так и отличаем.
function classify(px, w, isl, bg, tol) {
  const { x0, y0, x1, y1 } = isl, bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  let filled = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (far(px, (y * w + x) * 3, bg, tol)) filled++;
  const d = 2, cor = (cx, cy) => far(px, (cy * w + cx) * 3, bg, tol) ? 1 : 0;
  const corners = cor(x0 + d, y0 + d) + cor(x1 - d, y0 + d) + cor(x0 + d, y1 - d) + cor(x1 - d, y1 - d);
  const extent = filled / (bw * bh), aspect = Math.min(bw, bh) / Math.max(bw, bh);
  let shape;
  if (corners >= 3 && extent > 0.85) shape = "rect";
  else if (corners <= 1 && aspect > 0.82 && extent > 0.6 && extent < 0.9) shape = "circle";
  else if (extent > 0.5) shape = "round-rect";
  else shape = "blob";
  // признак картинки: (1) МНОГО разных цветов, (2) плотные «резкие» края, (3) НИ ОДИН цвет не доминирует.
  // (3) отделяет ФОТО от текста/UI: у текста фон (белый) занимает >45% пикселей, у фото — ни один цвет.
  const st = bw * bh > 12000 ? 2 : 1; // прореживание для скорости
  const cnt = new Map(), lum = new Set(); let edges = 0, samp = 0;
  for (let y = y0; y <= y1; y += st) for (let x = x0; x <= x1; x += st) {
    const j = (y * w + x) * 3; samp++;
    const key = ((px[j] >> 4) << 8) | ((px[j + 1] >> 4) << 4) | (px[j + 2] >> 4); cnt.set(key, (cnt.get(key) || 0) + 1);
    lum.add(((0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2]) | 0) >> 4); // 4-битный уровень яркости (для Ч/Б фото)
    if (x + st <= x1) { const k = j + st * 3; if (Math.max(Math.abs(px[j] - px[k]), Math.abs(px[j + 1] - px[k + 1]), Math.abs(px[j + 2] - px[k + 2])) > 24) edges++; }
  }
  let dom = 0; for (const c of cnt.values()) if (c > dom) dom = c;
  const edgeDens = edges / (samp || 1), domFrac = dom / (samp || 1);
  // фото: (много ЦВЕТОВ ИЛИ много уровней ЯРКОСТИ — для Ч/Б) + плотные края + нет доминирующего фона
  const image = bw > 16 && bh > 16 && (cnt.size >= 64 || lum.size >= 13) && edgeDens > 0.12 && domFrac < 0.45;
  return { shape, image, colors: cnt.size, edge: +edgeDens.toFixed(2), dom: +domFrac.toFixed(2) };
}

// bbox КРУПНЕЙШЕЙ СВЯЗНОЙ области цвета фона внутри рамки («поверхность»/холст — напр. серый body
// между хедером и футером; берём связную, чтобы не слить body с пустым фоном под футером через тёмную полосу)
function bgBBox(px, w, h, x0, y0, x1, y1, bg, tol, seen, stamp) {
  const q = []; let best = null;
  for (let sy = y0; sy <= y1; sy++) for (let sx = x0; sx <= x1; sx++) {
    const s = sy * w + sx; if (seen[s] === stamp || far(px, s * 3, bg, tol)) continue;
    seen[s] = stamp; let head = 0; q.length = 0; q.push(s);
    let ax0 = sx, ay0 = sy, ax1 = sx, ay1 = sy, n = 0;
    while (head < q.length) { const pp = q[head++], pxx = pp % w, pyy = (pp / w) | 0; n++;
      if (pxx < ax0) ax0 = pxx; if (pxx > ax1) ax1 = pxx; if (pyy < ay0) ay0 = pyy; if (pyy > ay1) ay1 = pyy;
      const tN = (nn, nx, ny) => { if (nx < x0 || nx > x1 || ny < y0 || ny > y1) return; if (seen[nn] !== stamp && !far(px, nn * 3, bg, tol)) { seen[nn] = stamp; q.push(nn); } };
      if (pxx + 1 <= x1) tN(pp + 1, pxx + 1, pyy); if (pxx - 1 >= x0) tN(pp - 1, pxx - 1, pyy);
      if (pyy + 1 <= y1) tN(pp + w, pxx, pyy + 1); if (pyy - 1 >= y0) tN(pp - w, pxx, pyy - 1); }
    if (!best || n > best.area) best = { x0: ax0, y0: ay0, x1: ax1, y1: ay1, area: n };
  }
  return best;
}
const inside = (o, S) => o.x0 >= S.x0 && o.y0 >= S.y0 && o.x1 <= S.x1 && o.y1 <= S.y1;
const lumAt = (px, j) => 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];

// Горизонтальные ЛИНИИ-РАЗДЕЛИТЕЛИ (валли: строка темнее и сверху, и снизу — рамка/сепаратор, не смена цвета).
// Хедер/футер часто того же цвета, что и фон, и отделены только такой линией. Возвращаем y-позиции.
function hDividers(px, w, x0, y0, x1, y1) {
  const span = (x1 - x0) / 2 + 1, lines = [];
  for (let y = y0 + 3; y <= y1 - 3; y++) {
    let c = 0; for (let x = x0; x <= x1; x += 2) { const j = (y * w + x) * 3; if (lumAt(px, j) + 4 < lumAt(px, (y - 2) * w * 3 + x * 3) && lumAt(px, j) + 4 < lumAt(px, (y + 2) * w * 3 + x * 3)) c++; }
    if (c / span > 0.85) { if (lines.length && y - lines[lines.length - 1] <= 2) continue; lines.push(y); } // склеиваем 1–2px толщину
  }
  return lines;
}

// слить соседние картинки-ЛИСТЬЯ с общим родителем (одно фото могло разбиться на куски). Пост-проход.
function mergeImageNodes(nodes, pad = 5) {
  const box = (n) => n.box, removed = new Set(), byPar = new Map();
  for (const n of nodes) if (n.image) (byPar.get(n.parent) || byPar.set(n.parent, []).get(n.parent)).push(n);
  const near = (A, B) => A.box[0] - pad <= B.box[0] + B.box[2] && B.box[0] - pad <= A.box[0] + A.box[2] && A.box[1] - pad <= B.box[1] + B.box[3] && B.box[1] - pad <= A.box[1] + A.box[3];
  for (const g of byPar.values()) {
    if (g.length < 2) continue;
    const p = g.map((_, i) => i), find = (x) => { while (p[x] !== x) x = p[x] = p[p[x]]; return x; };
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) if (near(g[i], g[j])) p[find(i)] = find(j);
    const cl = new Map(); g.forEach((n, i) => { const r = find(i); (cl.get(r) || cl.set(r, []).get(r)).push(n); });
    for (const c of cl.values()) {
      if (c.length < 2) continue;
      const x0 = Math.min(...c.map((n) => n.box[0])), y0 = Math.min(...c.map((n) => n.box[1]));
      const x1 = Math.max(...c.map((n) => n.box[0] + n.box[2])), y1 = Math.max(...c.map((n) => n.box[1] + n.box[3]));
      c[0].box = [x0, y0, x1 - x0, y1 - y0]; c.slice(1).forEach((n) => removed.add(n.id)); // выживает первый, остальные — прочь
    }
  }
  return removed;
}

export function detect(buf, { maxW = 760, tol = 14, minAreaFrac = 0.0025, maxDepth = 4 } = {}) {
  const { px, w, h, s } = loadScaled(buf, maxW);
  const lab = new Int32Array(w * h).fill(-1), seen = new Int32Array(w * h).fill(-1); let stamp = 0;
  const minArea = Math.max(120, (minAreaFrac * w * h) | 0);
  const nodes = [];
  const emit = (box, shape, parent) => { const id = nodes.length; nodes.push({ id, parent, shape, image: false, box: [Math.round(box.x0 / s), Math.round(box.y0 / s), Math.round((box.x1 - box.x0 + 1) / s), Math.round((box.y1 - box.y0 + 1) / s)] }); return id; };
  // КАРТИНКА = текстурный ЛИСТ (нет под-структуры). Контейнер с фото внутри — не картинка, в него заходим.
  const recurse = (x0, y0, x1, y1, geoDepth, nodeId) => {
    const bg = bgColor(px, w, h, x0, y0, x1, y1);
    const levelArea = (x1 - x0) * (y1 - y0);
    const isl = geoDepth > maxDepth ? [] : islandsIn(px, w, h, x0, y0, x1, y1, bg, tol, minArea, lab, ++stamp);
    const sig = isl.filter((a) => (a.x1 - a.x0 + 1) * (a.y1 - a.y0 + 1) < 0.85 * levelArea); // под-острова (без near-full-дубля себя)
    if (sig.length === 0) {                       // ЛИСТ → это картинка или нет
      if (nodeId >= 0) { const cls = classify(px, w, { x0, y0, x1, y1 }, bg, tol); if (cls.image) { nodes[nodeId].image = true; nodes[nodeId].shape = "image"; } nodes[nodeId].colors = cls.colors; nodes[nodeId].edge = cls.edge; }
      return;
    }
    let surfId = nodeId, sb = null;               // ПОВЕРХНОСТЬ — только на верхнем уровне
    if (geoDepth === 0) { sb = bgBBox(px, w, h, x0, y0, x1, y1, bg, tol, seen, ++stamp); if (sb && sb.area > 0.15 * levelArea && (sb.x1 - sb.x0 + 1) * (sb.y1 - sb.y0 + 1) < 0.9 * levelArea) surfId = emit(sb, "surface", nodeId); }
    for (const a of sig) {                        // КОНТЕЙНЕР → эмитим детей и заходим внутрь (лист/картинка решится там)
      const par = (surfId !== nodeId && inside(a, sb)) ? surfId : nodeId;
      const id = emit(a, classify(px, w, a, bg, tol).shape, par);
      recurse(a.x0 + 1, a.y0 + 1, a.x1 - 1, a.y1 - 1, geoDepth + 1, id);
    }
  };
  recurse(0, 0, w - 1, h - 1, 0, -1);
  // ХЕДЕР/ФУТЕР: полосы того же цвета, что фон, отделённые линией-разделителем (figure-ground их не видит)
  const divs = hDividers(px, w, 0, 0, w - 1, h - 1);
  const band = (y0b, y1b) => { const id = nodes.length; nodes.push({ id, parent: -1, shape: "bar", image: false, depth: 0, box: [0, Math.round(y0b / s), Math.round(w / s), Math.round((y1b - y0b) / s)] }); };
  const topDiv = divs.find((y) => y < h * 0.22);
  if (topDiv && topDiv > 6) band(0, topDiv);                 // хедер = полоса над верхней линией
  const botDiv = [...divs].reverse().find((y) => y > h * 0.78);
  if (botDiv && h - botDiv > 6) band(botDiv, h - 1);          // футер = полоса под нижней линией
  nodes.forEach((n) => { if (n.depth == null) { let d = 0, p = n.parent; while (p >= 0) { d++; p = nodes[p].parent; } n.depth = d; } }); // глубина по цепочке (индекс=id)
  const removed = mergeImageNodes(nodes);         // слить соседние картинки-осколки одного фото
  return { W: Math.round(w / s), H: Math.round(h / s), nodes: nodes.filter((n) => !removed.has(n.id)) };
}

// БОКОВЫЕ ПАНЕЛИ (сайдбары) — вертикальный аналог hDividers. Сайдбар ПРИКЛЕЕН к краю экрана, поэтому
// и капля-по-цвету, и edgeRects (заливка от рамки) считают его ФОНОМ, а не регионом — фон дотекает до
// него от края, не пересекая границу. Но у сайдбара есть полная вертикальная граница-ВАЛЛИ (столбец
// темнее ОБОИХ соседей — тонкая линия/тень, даже если заливка того же цвета). Ищем такой столбец у
// левого/правого края → отрезаем полосу от края до него как панель. Симметрично хедеру/футеру.
export function sidePanels(buf, { maxW = 1577, minFrac = 0.5, wLo = 0.06, wHi = 0.4 } = {}) {
  const { W, H, data } = asFrame(buf);
  const s = Math.min(1, maxW / W), w = (W * s) | 0, h = (H * s) | 0;
  const Lum = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (((y / s) | 0) * W + ((x / s) | 0)) * 4; Lum[y * w + x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; }
  const span = h / 2 + 1, div = [];
  for (let x = 3; x < w - 3; x++) {
    let c = 0; for (let y = 0; y < h; y += 2) { const l = Lum[y * w + x]; if (l + 4 < Lum[y * w + x - 2] && l + 4 < Lum[y * w + x + 2]) c++; } // валли-столбец
    if (c / span > minFrac) { if (div.length && x - div[div.length - 1] <= 3) continue; div.push(x); }
  }
  const panels = [];
  const left = div.find((x) => x >= wLo * w && x <= wHi * w);
  if (left) panels.push([0, 0, Math.round(left / s), H]);                         // левый сайдбар: от края до разделителя
  const right = [...div].reverse().find((x) => x >= (1 - wHi) * w && x <= (1 - wLo) * w);
  if (right) panels.push([Math.round(right / s), 0, W - Math.round(right / s), H]); // правый рельс
  return { panels: panels.map((b) => ({ box: b })) };
}

// КАПЛЯ-ФОН УПИРАЕТСЯ В ГРАНИ. Карточки ТОГО ЖЕ цвета, что холст (напр. канвас Piano), фигура-фон по
// ЦВЕТУ не видит — их отделяет лишь тонкая грань-рамка (1px). Заливаем «фон» от рамки экрана, НЕ
// пересекая грани-стены; куда фон НЕ добрался — замкнутые карманы (рамка+нутро связны) = карточки.
// Так грань в 1px становится стеной. Фильтры: рамка опирается на стены (perim) + внутри крупная
// ПУСТАЯ заливка (emptyFrac) → отсекаем жирный текст и рыхлые группы. Возвращает боксы в px скрина.
export function edgeRects(buf, { maxW = 1577, T = 9, dil = 1, minSideCss = 34, perimMin = 0.5, emptyMin = 0.3 } = {}) {
  const { W, H, data } = asFrame(buf);
  const s = Math.min(1, maxW / W), w = (W * s) | 0, h = (H * s) | 0;
  const L = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (((y / s) | 0) * W + ((x / s) | 0)) * 4; L[y * w + x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; }
  let wall = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; wall[i] = ((x + 1 < w && Math.abs(L[i] - L[i + 1]) > T) || (y + 1 < h && Math.abs(L[i] - L[i + w]) > T) || (x > 0 && Math.abs(L[i] - L[i - 1]) > T) || (y > 0 && Math.abs(L[i] - L[i - w]) > T)) ? 1 : 0; }
  for (let d = 0; d < dil; d++) { const nw = wall.slice(); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (!wall[i] && ((x + 1 < w && wall[i + 1]) || (x > 0 && wall[i - 1]) || (y + 1 < h && wall[i + w]) || (y > 0 && wall[i - w]))) nw[i] = 1; } wall = nw; } // дилатация: закрыть 1px щели в рамках
  // НАЙТИ ЗАМКНУТЫЕ КАРМАНЫ внутри прямоугольника: заливаем «улицу»(фон) от ЕГО рамки по не-стенам;
  // всё, куда не дотекло (стены+нутро), = карманы (связные компоненты). Переиспользуем для РЕКУРСИИ
  // внутрь крупных карманов (колонка-контейнер) → находим вложенные под-карточки того же цвета.
  const findPockets = (rx0, ry0, rx1, ry1) => {
    const seen = new Uint8Array(w * h), q = [];
    const sd = (x, y) => { if (x < rx0 || x > rx1 || y < ry0 || y > ry1) return; const i = y * w + x; if (!wall[i] && !seen[i]) { seen[i] = 1; q.push(i); } };
    for (let x = rx0; x <= rx1; x++) { sd(x, ry0); sd(x, ry1); }
    for (let y = ry0; y <= ry1; y++) { sd(rx0, y); sd(rx1, y); }
    let head = 0; while (head < q.length) { const p = q[head++], x = p % w, y = (p / w) | 0; sd(x + 1, y); sd(x - 1, y); sd(x, y + 1); sd(x, y - 1); }
    const comp = new Uint8Array(w * h), out = [];
    for (let sy = ry0; sy <= ry1; sy++) for (let sx = rx0; sx <= rx1; sx++) {
      const s0 = sy * w + sx; if (seen[s0] || comp[s0]) continue;
      const cq = [s0]; comp[s0] = 1; let hh = 0, x0 = sx, y0 = sy, x1 = sx, y1 = sy, area = 0;
      while (hh < cq.length) { const p = cq[hh++], x = p % w, y = (p / w) | 0; area++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; const tN = (nx, ny) => { if (nx < rx0 || nx > rx1 || ny < ry0 || ny > ry1) return; const n = ny * w + nx; if (!seen[n] && !comp[n]) { comp[n] = 1; cq.push(n); } }; tN(x + 1, y); tN(x - 1, y); tN(x, y + 1); tN(x, y - 1); }
      out.push({ x0, y0, x1, y1, area, fill: area / ((x1 - x0 + 1) * (y1 - y0 + 1)) });
    }
    return out;
  };
  const boxes = findPockets(0, 0, w - 1, h - 1);
  const onWall = (x, y) => { for (let d = -2; d <= 2; d++) { if (x + d >= 0 && x + d < w && wall[y * w + x + d]) return 1; if (y + d >= 0 && y + d < h && wall[(y + d) * w + x]) return 1; } return 0; };
  const perim = (b) => { let c = 0, n = 0; for (let x = b.x0; x <= b.x1; x += 2) { n += 2; c += onWall(x, b.y0); c += onWall(x, b.y1); } for (let y = b.y0; y <= b.y1; y += 2) { n += 2; c += onWall(b.x0, y); c += onWall(b.x1, y); } return c / (n || 1); };
  const emptyFrac = (b) => { const ix0 = b.x0 + 4, iy0 = b.y0 + 4, ix1 = b.x1 - 4, iy1 = b.y1 - 4; if (ix1 <= ix0 || iy1 <= iy0) return 0; const bw = ix1 - ix0 + 1, seenL = new Uint8Array(bw * (iy1 - iy0 + 1)); let best = 0; const st = []; for (let sy = iy0; sy <= iy1; sy++) for (let sx = ix0; sx <= ix1; sx++) { const li = (sy - iy0) * bw + (sx - ix0); if (seenL[li] || wall[sy * w + sx]) continue; st.length = 0; st.push(sx, sy); seenL[li] = 1; let a = 0; while (st.length) { const y = st.pop(), x = st.pop(); a++; const tN = (nx, ny) => { if (nx < ix0 || nx > ix1 || ny < iy0 || ny > iy1) return; const l = (ny - iy0) * bw + (nx - ix0); if (!seenL[l] && !wall[ny * w + nx]) { seenL[l] = 1; st.push(nx, ny); } }; tN(x + 1, y); tN(x - 1, y); tN(x, y + 1); tN(x, y - 1); } if (a > best) best = a; } return best / (bw * (iy1 - iy0 + 1)); };
  const minSide = minSideCss * s;
  let cards = boxes.filter((b) => (b.x1 - b.x0) > minSide && (b.y1 - b.y0) > minSide && b.area > (44 * 44) * s * s && b.fill > 0.5);
  cards = cards.filter((b) => perim(b) > perimMin && emptyFrac(b) > emptyMin);
  cards.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
  // дедуп: убрать почти-совпадающие (IoU), но ОСТАВИТЬ вложенные под-карточки (колонка ⊃ карточки — низкий IoU)
  const iou = (a, b) => { const x0 = Math.max(a.x0, b.x0), y0 = Math.max(a.y0, b.y0), x1 = Math.min(a.x1, b.x1), y1 = Math.min(a.y1, b.y1); const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0), ua = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - i; return i / (ua + 1e-9); };
  const keep = [];
  for (const c of cards) { if (keep.some((k) => iou(c, k) > 0.7)) continue; keep.push(c); }
  return { W: Math.round(w / s), H: Math.round(h / s), rects: keep.map((c) => ({ box: [Math.round(c.x0 / s), Math.round(c.y0 / s), Math.round((c.x1 - c.x0) / s), Math.round((c.y1 - c.y0) / s)] })) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] || "eye/shots/complex-clean.png", tol = parseFloat(process.argv[3] || "14"), maxDepth = parseInt(process.argv[4] || "3");
  const t = Date.now(); const r = detect(fs.readFileSync(path), { tol, maxDepth });
  console.log(`${r.nodes.length} островов (tol=${tol} depth≤${maxDepth}) за ${((Date.now() - t) / 1000).toFixed(2)}с`);
  r.nodes.forEach((n) => console.log(`  ${"  ".repeat(n.depth)}#${n.id} d${n.depth} ${n.shape.padEnd(10)} @${n.box.join(",")}${n.parent >= 0 ? ` ⊂#${n.parent}` : ""}`));
  const COL = { bar: [255, 90, 0], image: [230, 20, 200], surface: [240, 160, 20], rect: [20, 160, 40], "round-rect": [40, 100, 230], circle: [230, 30, 30], blob: [160, 90, 220] };
  const png = PNG.sync.read(fs.readFileSync(path)); const { width: W, height: H, data } = png;
  const set = (x, y, c) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; };
  r.nodes.forEach((n) => { const c = COL[n.shape], [x, y, bw, bh] = n.box; for (let t = 0; t < 3; t++) { for (let xx = x; xx <= x + bw; xx++) { set(xx, y + t, c); set(xx, y + bh - t, c); } for (let yy = y; yy <= y + bh; yy++) { set(x + t, yy, c); set(x + bw - t, yy, c); } } });
  fs.writeFileSync(path.replace(/\.png$/, "-islands.png"), PNG.sync.write(png));
  console.log("→ " + path.replace(/\.png$/, "-islands.png"));
}
