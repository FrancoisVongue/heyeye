// QA: прогнать perceive (капля + XY-бэкап) на скриншоте, нарисовать ТОЛСТЫЕ боксы, уменьшить для просмотра.
import { PNG } from "pngjs"; import fs from "node:fs";
import { detect } from "../src/islands.js";
import { cut } from "../src/xycut.js";

const path = process.argv[2];
const buf = fs.readFileSync(path);
const r = detect(buf, { tol: 12, maxDepth: 3 });
const rich = r.nodes.filter((n) => n.shape !== "surface" && n.box[2] * n.box[3] > 0.012 * r.W * r.H).length;
const ovl = (a, b) => { const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]), x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]); const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0); return i / (Math.min(a[2] * a[3], b[2] * b[3]) + 1e-9); };
let nodes, mode;
if (rich >= 6) { nodes = r.nodes; mode = "regions"; }
else { const xr = cut(buf, { gapFrac: 0.011 }); const imgs = r.nodes.filter((n) => n.image); nodes = imgs.map((im) => ({ shape: "image", box: im.box })); for (const b of xr.blocks) if (!imgs.some((im) => ovl(b, im.box) > 0.5)) nodes.push({ shape: "block", box: b }); mode = "regions+xy"; }
console.log(`${path}: ${nodes.length} узлов, ${mode} (rich=${rich})`);

const COL = { block: [14, 165, 183], image: [230, 20, 200], surface: [240, 160, 20], rect: [20, 160, 40], "round-rect": [40, 100, 230], circle: [230, 30, 30], blob: [160, 90, 220], bar: [255, 90, 0] };
const png = PNG.sync.read(buf); const { width: W, height: H, data } = png;
const set = (x, y, c) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; };
const th = 5;
for (const n of nodes.filter((n) => (n.depth ?? 0) <= 1)) { const c = COL[n.shape] || [120, 120, 120], [x, y, bw, bh] = n.box; for (let t = 0; t < th; t++) { for (let xx = x; xx <= x + bw; xx++) { set(xx, y + t, c); set(xx, y + bh - t, c); } for (let yy = y; yy <= y + bh; yy++) { set(x + t, yy, c); set(x + bw - t, yy, c); } } }
fs.writeFileSync(path.replace(/\.png$/, "-qafull.png"), PNG.sync.write(png)); // полноразмер с боксами (для кропов)
// уменьшить до 820 шир
const s = 820 / W, w = (W * s) | 0, hh = (H * s) | 0, o = new PNG({ width: w, height: hh });
for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) { const sx = (x / s) | 0, sy = (y / s) | 0, si = (sy * W + sx) * 4, di = (y * w + x) * 4; o.data[di] = data[si]; o.data[di + 1] = data[si + 1]; o.data[di + 2] = data[si + 2]; o.data[di + 3] = 255; }
const out = path.replace(/\.png$/, "-qa.png"); fs.writeFileSync(out, PNG.sync.write(o));
console.log("→ " + out);
