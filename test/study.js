// ИЗУЧЕНИЕ детекции контейнеров/карточек на ОДНОМ скрине (офлайн, без демона): рисуем все три слоя
// разными цветами, чтобы видеть, что ловит каждый и чего НЕ хватает.
//   islands (капля по цвету) = зелёный/маджента(картинка) · edgeRects (грань-карманы) = красный · sidePanels = синий
import { PNG } from "pngjs";
import fs from "node:fs";
import * as I from "../src/islands.js";

const path = process.argv[2] || "eye/shots/clean-piano.png";
const buf = fs.readFileSync(path);
const isl = I.detect(buf, { tol: 12, maxDepth: 3 });
const regions = isl.nodes.filter((n) => !n.image && n.shape !== "surface" && n.depth <= 2 && n.box[2] * n.box[3] > 0.003 * isl.W * isl.H);
const images = isl.nodes.filter((n) => n.image);
const canvasy = regions.length <= 2 && images.length === 0;
const er = I.edgeRects(buf, canvasy ? { perimMin: 0.4, emptyMin: 0.1 } : {});
const sp = I.sidePanels(buf);
console.log(`islands: ${regions.length} регионов + ${images.length} картинок | edgeRects: ${er.rects.length} | sidePanels: ${sp.panels.length}`);

const png = PNG.sync.read(buf); const { width: W, height: H, data } = png;
const OS = 1100 / W, ow = (W * OS) | 0, oh = (H * OS) | 0, o = new PNG({ width: ow, height: oh });
for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) { const i = (((y / OS) | 0) * W + ((x / OS) | 0)) * 4, j = (y * ow + x) * 4; o.data[j] = data[i]; o.data[j + 1] = data[i + 1]; o.data[j + 2] = data[i + 2]; o.data[j + 3] = 255; }
const set = (x, y, c) => { if (x < 0 || y < 0 || x >= ow || y >= oh) return; const j = (y * ow + x) * 4; o.data[j] = c[0]; o.data[j + 1] = c[1]; o.data[j + 2] = c[2]; };
const box = (b, c, th = 2) => { const x = (b[0] * OS) | 0, y = (b[1] * OS) | 0, bw = (b[2] * OS) | 0, bh = (b[3] * OS) | 0; for (let t = 0; t < th; t++) { for (let xx = x; xx <= x + bw; xx++) { set(xx, y + t, c); set(xx, y + bh - t, c); } for (let yy = y; yy <= y + bh; yy++) { set(x + t, yy, c); set(x + bw - t, yy, c); } } };
for (const n of regions) box(n.box, [30, 170, 60]);       // зелёный = капля по цвету
for (const n of images) box(n.box, [230, 20, 200]);       // маджента = картинка
for (const c of er.rects) box(c.box, [230, 30, 30]);      // красный = грань-карманы
for (const c of sp.panels) box(c.box, [40, 90, 240], 3);  // синий = боковая панель
const out = path.replace(/\.png$/, "-study.png"); fs.writeFileSync(out, PNG.sync.write(o));
console.log("→ " + out + `  (${ow}×${oh})`);
