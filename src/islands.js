// КОНТЕЙНЕРЫ = ОСТРОВА «НЕ-ФОНА», рекурсивно. CPU, без ML. Модель мышления юзера:
//   фон = самый частый цвет страницы. Всё, что не фон, — острова (карточки/панели/hero).
//   Текст/градиент внутри острова НЕ дробят его: важно лишь «не фон», а не похожесть цвета,
//   поэтому карточка(градиент+белое+текст) = ОДИН связный остров. Затем ЗАХОДИМ внутрь каждого
//   острова: там фон = его собственный цвет → находим вложенные (кнопки/картинки/подпанели).
import { PNG } from "pngjs";
import fs from "node:fs";

function loadScaled(buf, maxW) {
  const png = PNG.sync.read(buf); const { width: W, height: H, data } = png;
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
