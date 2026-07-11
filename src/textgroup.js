// ГРУППИРОВКА ТЕКСТА в блоки. OCR → строки с размером → union-find: строки одного РАЗМЕРА,
// выровненные по горизонтали и с НОРМАЛЬНЫМ межстрочным интервалом → один блок (параграф/заголовок).
// Ловит белые карточки без цветовых границ (BBC/Yahoo), где капля пасует. Чистый JS, OCR = tesseract.
import { ocrAsync as ocr } from "./vision.js";

const ox = (a, b) => { const x0 = Math.max(a[0], b[0]), x1 = Math.min(a[0] + a[2], b[0] + b[2]); return Math.max(0, x1 - x0) / Math.min(a[2], b[2]); };
const vgap = (a, b) => { const top = Math.max(a[1], b[1]), bot = Math.min(a[1] + a[3], b[1] + b[3]); return top - bot; }; // >0 = зазор

// buf → блоки текста [{box,lines,size}]
const clean = (t) => { const a = (t.match(/[\p{L}\p{N}]/gu) || []).length; return a >= 2 && a / t.length > 0.45; }; // не мусор с фото
const bboxOf = (g) => { const x0 = Math.min(...g.map((l) => l.box[0])), y0 = Math.min(...g.map((l) => l.box[1])), x1 = Math.max(...g.map((l) => l.box[0] + l.box[2])), y1 = Math.max(...g.map((l) => l.box[1] + l.box[3])); return [x0, y0, x1 - x0, y1 - y0]; };
const uf = (n) => { const p = [...Array(n).keys()], f = (x) => { while (p[x] !== x) x = p[x] = p[p[x]]; return x; }; return { f, u: (a, b) => { p[f(a)] = f(b); } }; };
const vov = (a, b) => { const t = Math.max(a[1], b[1]), bo = Math.min(a[1] + a[3], b[1] + b[3]); return Math.max(0, bo - t) / Math.min(a[3], b[3]); };

export async function textBlocks(buf, { conf = 40 } = {}) {
  const { W, H, words } = await ocr(buf);
  const wd = words.filter((w) => w.conf >= conf && clean(w.text));
  // 1) СЛОВА → СТРОКИ: слова на одной строке (верт. перекрытие) и рядом по x (разрыв < высоты).
  //    Большой горизонтальный разрыв = гуттер колонки → строка НЕ продолжается через колонки.
  const nw = wd.length, lu = uf(nw);
  for (let i = 0; i < nw; i++) for (let j = i + 1; j < nw; j++) {
    const a = wd[i].box, b = wd[j].box;
    if (vov(a, b) > 0.5) { const gap = Math.max(a[0], b[0]) - Math.min(a[0] + a[2], b[0] + b[2]); if (gap < 1.2 * Math.max(a[3], b[3])) lu.u(i, j); }
  }
  const lm = new Map(); wd.forEach((w, i) => { const r = lu.f(i); (lm.get(r) || lm.set(r, []).get(r)).push(w); });
  const L = [...lm.values()].map((g) => ({ box: bboxOf(g), h: Math.round(g.reduce((s, w) => s + w.box[3], 0) / g.length), text: g.sort((a, b) => a.box[0] - b.box[0]).map((w) => w.text).join(" ") }));
  // 2) СТРОКИ → БЛОКИ
  const n = L.length, { f: find, u: union } = uf(n);
  // соседние строки одного блока: похожий размер + горизонт. перекрытие + вертикальный зазор ≈ строка (не прыжок)
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = L[i], b = L[j];
    const sizeOk = Math.abs(a.h - b.h) / Math.max(a.h, b.h) < 0.35;
    const xOk = ox(a.box, b.box) > 0.5;
    const g = vgap(a.box, b.box), gapOk = g > -a.h * 0.5 && g < 0.9 * Math.max(a.h, b.h); // подряд идущие строки
    if (sizeOk && xOk && gapOk) union(i, j);
  }
  const groups = new Map();
  L.forEach((l, i) => { const r = find(i); (groups.get(r) || groups.set(r, []).get(r)).push(l); });
  let blocks = [];
  for (const g of groups.values()) {
    const x0 = Math.min(...g.map((l) => l.box[0])), y0 = Math.min(...g.map((l) => l.box[1]));
    const x1 = Math.max(...g.map((l) => l.box[0] + l.box[2])), y1 = Math.max(...g.map((l) => l.box[1] + l.box[3]));
    blocks.push({ box: [x0, y0, x1 - x0, y1 - y0], lines: g.length, size: Math.round(g.reduce((s, l) => s + l.h, 0) / g.length), text: g.map((l) => l.text).join(" ") });
  }
  blocks = blocks.filter((b) => b.box[2] > 8 && b.box[3] > 6);
  // слить ОДНОСТРОЧНЫЕ блоки одного размера, выровненные в РЯД (нав/меню/кнопки). Многострочные не трогаем.
  const mono = blocks.filter((b) => b.lines === 1), rest = blocks.filter((b) => b.lines !== 1);
  const mn = mono.length, mu = uf(mn);
  for (let i = 0; i < mn; i++) for (let j = i + 1; j < mn; j++) {
    const a = mono[i], b = mono[j];
    const sizeOk = Math.abs(a.size - b.size) / Math.max(a.size, b.size) < 0.3;
    const rowOk = vov(a.box, b.box) > 0.5, gap = Math.max(a.box[0], b.box[0]) - Math.min(a.box[0] + a.box[2], b.box[0] + b.box[2]);
    if (sizeOk && rowOk && gap < 2.5 * a.box[3]) mu.u(i, j);
  }
  const rows = new Map(); mono.forEach((b, i) => { const r = mu.f(i); (rows.get(r) || rows.set(r, []).get(r)).push(b); });
  const merged = [...rows.values()].map((g) => g.length === 1 ? g[0] : { box: bboxOf(g), lines: 1, size: g[0].size, text: g.map((x) => x.text).join(" ") });
  // ВЕРТИКАЛЬНАЯ группировка: блоки одного размера, выровненные по ЛЕВОМУ краю, с умеренным зазором,
  // в одном столбце → одна колонка/список (сайдбар-нав, список ссылок, столбец параграфов секции).
  let fin = rest.concat(merged); const fn = fin.length, vu = uf(fn);
  for (let i = 0; i < fn; i++) for (let j = i + 1; j < fn; j++) {
    const a = fin[i], b = fin[j];
    const sizeOk = Math.abs(a.size - b.size) / Math.max(a.size, b.size) < 0.3;
    const leftOk = Math.abs(a.box[0] - b.box[0]) < Math.max(14, 0.7 * Math.max(a.size, b.size));
    const g = vgap(a.box, b.box), gapOk = g > -Math.max(a.box[3], b.box[3]) && g < 1.8 * Math.max(a.size, b.size);
    if (sizeOk && leftOk && gapOk && ox(a.box, b.box) > 0.4) vu.u(i, j);
  }
  const cols = new Map(); fin.forEach((b, i) => { const r = vu.f(i); (cols.get(r) || cols.set(r, []).get(r)).push(b); });
  fin = [...cols.values()].map((g) => g.length === 1 ? g[0] : { box: bboxOf(g), lines: g.reduce((s, x) => s + x.lines, 0), size: g[0].size, text: g.map((x) => x.text).join(" ") });
  return { W, H, blocks: fin };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import("node:fs");
  const path = process.argv[2] || "eye/shots/raw-bbc.png";
  const t = Date.now(); const r = await textBlocks(fs.readFileSync(path));
  console.log(`${r.blocks.length} текст-блоков за ${((Date.now() - t) / 1000).toFixed(1)}с`);
  r.blocks.sort((a, b) => a.box[1] - b.box[1]).slice(0, 40).forEach((b, i) => console.log(`  [${i + 1}] @${b.box.join(",")} строк=${b.lines} разм=${b.size} "${b.text.slice(0, 45)}"`));
  // overlay
  const { PNG } = await import("pngjs");
  const png = PNG.sync.read(fs.readFileSync(path)); const { width: W, height: H, data } = png;
  const set = (x, y, c) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; };
  r.blocks.forEach((b, i) => { const c = [[230, 30, 30], [30, 170, 60], [40, 90, 230], [230, 150, 0]][i % 4], [x, y, bw, bh] = b.box; for (let t = 0; t < 4; t++) { for (let xx = x; xx <= x + bw; xx++) { set(xx, y + t, c); set(xx, y + bh - t, c); } for (let yy = y; yy <= y + bh; yy++) { set(x + t, yy, c); set(x + bw - t, yy, c); } } });
  const s = 820 / W, w = (W * s) | 0, hh = (H * s) | 0, o = new PNG({ width: w, height: hh });
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) { const sx = (x / s) | 0, sy = (y / s) | 0, si = (sy * W + sx) * 4, di = (y * w + x) * 4; o.data[di] = data[si]; o.data[di + 1] = data[si + 1]; o.data[di + 2] = data[si + 2]; o.data[di + 3] = 255; }
  fs.writeFileSync(path.replace(/\.png$/, "-tg.png"), PNG.sync.write(o));
  console.log("→ " + path.replace(/\.png$/, "-tg.png"));
}
