// РЕКОНСТРУКЦИЯ ПРЯМОУГОЛЬНИКОВ ПО КРАЯМ (для перекрытых окон). CPU, без ML.
// Идея: перекрытые одноцветные окна сливаются в один блоб по цвету, НО их границы (рамка+тень
// верхнего окна поверх нижнего) видны как ДЛИННЫЕ ПРЯМЫЕ КРАЯ. Окно = прямоугольник, у которого
// все 4 стороны опираются на такие края. Собираем сетку из вертикальных/горизонтальных краёв и
// перебираем прямоугольники (их мало — координат краёв единицы). Оставляем максимальные.
import { PNG } from "pngjs";
import fs from "node:fs";

export function detectRects(buf, { maxW = 760, T = 18, minSide = 40 } = {}) {
  const png = PNG.sync.read(buf); const { width: W, height: H, data } = png;
  const s = Math.min(1, maxW / W), w = (W * s) | 0, h = (H * s) | 0;
  const L = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (((y / s) | 0) * W + ((x / s) | 0)) * 4; L[y * w + x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; }
  const vE = new Uint8Array(w * h), hE = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    if (Math.abs(L[y * w + x + 1] - L[y * w + x - 1]) > T) vE[y * w + x] = 1;
    if (Math.abs(L[(y + 1) * w + x] - L[(y - 1) * w + x]) > T) hE[y * w + x] = 1;
  }
  // столбцы/строки с ДЛИННЫМ прямым краем → кандидаты линий (кластеризуем близкие)
  const cluster = (arr) => { arr.sort((a, b) => a.p - b.p); const out = []; for (const c of arr) { if (out.length && c.p - out[out.length - 1].p <= 8) { if (c.len > out[out.length - 1].len) out[out.length - 1] = c; } else out.push(c); } return out; };
  const VX = []; for (let x = 1; x < w - 1; x++) { let run = 0, best = 0, y0 = 0, cy = 0; for (let y = 0; y < h; y++) { if (vE[y * w + x]) { if (!run) cy = y; run++; if (run > best) { best = run; y0 = cy; } } else run = 0; } if (best > 0.12 * h) VX.push({ p: x, len: best, a: y0, b: y0 + best }); }
  const HY = []; for (let y = 1; y < h - 1; y++) { let run = 0, best = 0, x0 = 0, cx = 0; for (let x = 0; x < w; x++) { if (hE[y * w + x]) { if (!run) cx = x; run++; if (run > best) { best = run; x0 = cx; } } else run = 0; } if (best > 0.12 * w) HY.push({ p: y, len: best, a: x0, b: x0 + best }); }
  const vx = cluster(VX), hy = cluster(HY);

  // опора края: доля стороны, покрытая краем (в пределах ±2 пикселей)
  const hasH = (y, x0, x1) => { let c = 0, n = 0; for (let x = x0; x <= x1; x += 2) { n++; let e = 0; for (let dy = -2; dy <= 2; dy++) if (y + dy >= 0 && y + dy < h && hE[(y + dy) * w + x]) { e = 1; break; } c += e; } return c / (n || 1); };
  const hasV = (x, y0, y1) => { let c = 0, n = 0; for (let y = y0; y <= y1; y += 2) { n++; let e = 0; for (let dx = -2; dx <= 2; dx++) if (x + dx >= 0 && x + dx < w && vE[y * w + x + dx]) { e = 1; break; } c += e; } return c / (n || 1); };
  const light = (x0, y0, x1, y1) => { let c = 0, n = 0; for (let y = y0 + 2; y < y1 - 1; y += 4) for (let x = x0 + 2; x < x1 - 1; x += 4) { n++; if (L[y * w + x] > 150) c++; } return c / (n || 1); };

  // перебор прямоугольников: минимум 3 из 4 сторон СИЛЬНО опираются на края (4-я может быть скрыта
  // верхним окном — достраиваем), + светлая середина. Это amodal-достройка перекрытых окон.
  const cand = [];
  for (let i = 0; i < vx.length; i++) for (let j = i + 1; j < vx.length; j++) for (let k = 0; k < hy.length; k++) for (let l = k + 1; l < hy.length; l++) {
    const xi = vx[i].p, xj = vx[j].p, yk = hy[k].p, yl = hy[l].p;
    if (xj - xi < minSide * s || yl - yk < minSide * s) continue;
    const sides = [hasV(xi, yk, yl), hasV(xj, yk, yl), hasH(yk, xi, xj), hasH(yl, xi, xj)];
    if (sides.every((v) => v > 0.72) && light(xi, yk, xj, yl) > 0.9) // все 4 стороны на краях + светлая середина
      cand.push({ x0: xi, y0: yk, x1: xj, y1: yl, area: (xj - xi) * (yl - yk), score: sides.reduce((a, b) => a + b, 0) });
  }
  // оставляем МАКСИМАЛЬНЫЕ: убираем прямоугольник, если он строго внутри другого валидного (напр. заголовок внутри окна)
  cand.sort((a, b) => b.area - a.area);
  const iou = (a, b) => { const x0 = Math.max(a.x0, b.x0), y0 = Math.max(a.y0, b.y0), x1 = Math.min(a.x1, b.x1), y1 = Math.min(a.y1, b.y1); const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0); return i / (a.area + b.area - i); };
  const keep = [];
  for (const c of cand) {
    const contained = keep.some((k) => c.x0 >= k.x0 - 2 && c.y0 >= k.y0 - 2 && c.x1 <= k.x1 + 2 && c.y1 <= k.y1 + 2); // заголовок внутри окна
    const dup = keep.some((k) => iou(c, k) > 0.6); // почти тот же прямоугольник
    if (!contained && !dup) keep.push(c);
  }
  return { W: Math.round(w / s), H: Math.round(h / s), rects: keep.map((c) => ({ box: [Math.round(c.x0 / s), Math.round(c.y0 / s), Math.round((c.x1 - c.x0) / s), Math.round((c.y1 - c.y0) / s)] })) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] || "eye/shots/overlap-clean.png", T = parseFloat(process.argv[3] || "18");
  const t = Date.now(); const r = detectRects(fs.readFileSync(path), { T });
  console.log(`${r.rects.length} прямоугольников (T=${T}) за ${((Date.now() - t) / 1000).toFixed(2)}с`);
  r.rects.forEach((c, i) => console.log(`  [${i + 1}] @${c.box.join(",")}`));
  const png = PNG.sync.read(fs.readFileSync(path)); const { width: W, height: H, data } = png;
  const COL = [[230, 30, 30], [30, 180, 60], [40, 100, 240], [240, 160, 0], [200, 0, 200]];
  const set = (x, y, c) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; };
  r.rects.forEach((c, i) => { const col = COL[i % 5], [x, y, bw, bh] = c.box; for (let t = 0; t < 4; t++) { for (let xx = x; xx <= x + bw; xx++) { set(xx, y + t, col); set(xx, y + bh - t, col); } for (let yy = y; yy <= y + bh; yy++) { set(x + t, yy, col); set(x + bw - t, yy, col); } } });
  fs.writeFileSync(path.replace(/\.png$/, "-rects.png"), PNG.sync.write(png));
  console.log("→ " + path.replace(/\.png$/, "-rects.png"));
}
