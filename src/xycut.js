// XY-CUT: рекурсивный рез по ПУСТОТАМ. CPU, без ML. Бэкап для чисто-текстовых страниц (статьи),
// где капля-регионы «жидкие». Даёт колонки (вертикальные пустые коридоры) и секции/параграфы
// (аномально широкие горизонтальные пустоты). Каждый рез — по самой ШИРОКОЙ внутренней пустоте.
import { PNG } from "pngjs";
import fs from "node:fs";

function load(buf, maxW) {
  const png = PNG.sync.read(buf); const { width: W, height: H, data } = png;
  const s = Math.min(1, maxW / W), w = (W * s) | 0, h = (H * s) | 0;
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (((y / s) | 0) * W + ((x / s) | 0)) * 4, j = (y * w + x) * 3; rgb[j] = data[i]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i + 2]; }
  return { rgb, w, h, s };
}
// фон = мода по рамке; ink = «не фон» (текст/картинки)
function bgOf(rgb, w, h) {
  const hist = new Map(); const add = (x, y) => { const j = (y * w + x) * 3, k = ((rgb[j] >> 3) << 10) | ((rgb[j + 1] >> 3) << 5) | (rgb[j + 2] >> 3); hist.set(k, (hist.get(k) || 0) + 1); };
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); } for (let y = 0; y < h; y++) { add(0, y); add(w - 1, y); }
  let bk = 0, bc = -1; for (const [k, c] of hist) if (c > bc) { bc = c; bk = k; } return [((bk >> 10) & 31) << 3, ((bk >> 5) & 31) << 3, (bk & 31) << 3];
}

export function cut(buf, { maxW = 900, inkTol = 42, gapFrac = 0.02, minSize = 40, maxDepth = 14 } = {}) {
  const { rgb, w, h, s } = load(buf, maxW);
  const BG = bgOf(rgb, w, h);
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) { const j = i * 3; if (Math.max(Math.abs(rgb[j] - BG[0]), Math.abs(rgb[j + 1] - BG[1]), Math.abs(rgb[j + 2] - BG[2])) > inkTol) ink[i] = 1; }

  const gapMin = Math.max(6, gapFrac * Math.min(w, h) | 0);
  const blocks = [];
  // найти самую широкую ВНУТРЕННЮЮ пустоту вдоль оси; вернуть {pos,width} или null
  const findGap = (x0, y0, x1, y1, axis) => {
    const inkAt = axis === "y" // горизонтальные пустоты (пустые строки) → рез по y
      ? (p) => { for (let x = x0; x <= x1; x++) if (ink[p * w + x]) return true; return false; }
      : (p) => { for (let y = y0; y <= y1; y++) if (ink[y * w + p]) return true; return false; };
    const lo = axis === "y" ? y0 : x0, hi = axis === "y" ? y1 : x1;
    let best = null, run = 0, start = 0;
    for (let p = lo; p <= hi; p++) {
      if (!inkAt(p)) { if (run === 0) start = p; run++; } else { if (run >= gapMin && start > lo && p - 1 < hi) { const width = run; if (!best || width > best.width) best = { pos: (start + p - 1) >> 1, width }; } run = 0; }
    }
    return best;
  };
  const rec = (x0, y0, x1, y1, depth) => {
    if (depth > maxDepth || x1 - x0 < minSize * s || y1 - y0 < minSize * s) { blocks.push([x0, y0, x1, y1]); return; }
    // подрежем внешние поля (пустые края) до контента
    let cx0 = x0, cy0 = y0, cx1 = x1, cy1 = y1;
    const rowInk = (yy) => { for (let x = x0; x <= x1; x++) if (ink[yy * w + x]) return true; return false; };
    const colInk = (xx) => { for (let y = y0; y <= y1; y++) if (ink[y * w + xx]) return true; return false; };
    while (cy0 < cy1 && !rowInk(cy0)) cy0++; while (cy1 > cy0 && !rowInk(cy1)) cy1--;
    while (cx0 < cx1 && !colInk(cx0)) cx0++; while (cx1 > cx0 && !colInk(cx1)) cx1--;
    if (cx1 - cx0 < minSize * s || cy1 - cy0 < minSize * s) { blocks.push([cx0, cy0, cx1, cy1]); return; }
    const gv = findGap(cx0, cy0, cx1, cy1, "x"); // вертикальная пустота (колонки)
    const gh = findGap(cx0, cy0, cx1, cy1, "y"); // горизонтальная пустота (секции/параграфы)
    const useV = gv && (!gh || gv.width >= gh.width);
    if (useV && gv) { rec(cx0, cy0, gv.pos, cy1, depth + 1); rec(gv.pos, cy0, cx1, cy1, depth + 1); }
    else if (gh) { rec(cx0, cy0, cx1, gh.pos, depth + 1); rec(cx0, gh.pos, cx1, cy1, depth + 1); }
    else blocks.push([cx0, cy0, cx1, cy1]); // пустот нет → лист (блок текста)
  };
  rec(0, 0, w - 1, h - 1, 0);
  return { W: Math.round(w / s), H: Math.round(h / s), blocks: blocks.map((b) => [Math.round(b[0] / s), Math.round(b[1] / s), Math.round((b[2] - b[0]) / s), Math.round((b[3] - b[1]) / s)]).filter((b) => b[2] > 12 && b[3] > 8) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] || "eye/shots/wiki.png", gap = parseFloat(process.argv[3] || "0.02");
  const t = Date.now(); const r = cut(fs.readFileSync(path), { gapFrac: gap });
  console.log(`${r.blocks.length} блоков (gap=${gap}) за ${((Date.now() - t) / 1000).toFixed(2)}с`);
  const png = PNG.sync.read(fs.readFileSync(path)); const { width: W, height: H, data } = png;
  const set = (x, y, c) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; };
  r.blocks.forEach((b, i) => { const c = [[230, 40, 40], [40, 170, 60], [40, 90, 230], [230, 150, 0]][i % 4], [x, y, bw, bh] = b; for (let t = 0; t < 2; t++) { for (let xx = x; xx <= x + bw; xx++) { set(xx, y + t, c); set(xx, y + bh - t, c); } for (let yy = y; yy <= y + bh; yy++) { set(x + t, yy, c); set(x + bw - t, yy, c); } } });
  fs.writeFileSync(path.replace(/\.png$/, "-xy.png"), PNG.sync.write(png));
  console.log("→ " + path.replace(/\.png$/, "-xy.png"));
}
