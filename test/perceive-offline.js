// Полный perceive() ОФЛАЙН на чистом скрине (без демона): островки+текст+кнопки+грань-карточки+сайдбар
// +вложенность+бары+фовеальность. Рисуем итог и печатаем сводку. Так проверяем ПОЛНЫЙ конвейер.
import { PNG } from "pngjs";
import fs from "node:fs";
import { perceive } from "../src/perceive.js";

const COL = { button: [245, 158, 11], text: [14, 165, 183], block: [8, 145, 178], bar: [255, 90, 0], image: [230, 20, 200], surface: [240, 160, 20], rect: [22, 163, 74], "round-rect": [47, 107, 255], circle: [225, 29, 72], blob: [164, 75, 255] };
const path = process.argv[2] || "eye/shots/clean-piano.png";
const buf = fs.readFileSync(path);
const r = await perceive(buf, new URLSearchParams(""));
const by = {}; for (const n of r.nodes) by[n.shape] = (by[n.shape] || 0) + 1;
console.log(`${r.nodes.length} узлов (${r.mode}):`, JSON.stringify(by));
// «Before release» ~ css 315,285 — есть ли там rect (ложная карточка) или только text?
const at = (cx, cy, sh) => r.nodes.filter((n) => n.box[0] / 2 < cx && (n.box[0] + n.box[2]) / 2 > cx && n.box[1] / 2 < cy && (n.box[1] + n.box[3]) / 2 > cy && (!sh || n.shape === sh));
console.log(`на "Before release" (css~440,300): ${at(440, 300).map((n) => n.shape).join(",") || "ничего"}`);

const png = PNG.sync.read(buf); const { width: W, height: H, data } = png;
const OS = 1200 / W, ow = (W * OS) | 0, oh = (H * OS) | 0, o = new PNG({ width: ow, height: oh });
for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) { const i = (((y / OS) | 0) * W + ((x / OS) | 0)) * 4, j = (y * ow + x) * 4; o.data[j] = data[i]; o.data[j + 1] = data[i + 1]; o.data[j + 2] = data[i + 2]; o.data[j + 3] = 255; }
const set = (x, y, c) => { if (x < 0 || y < 0 || x >= ow || y >= oh) return; const j = (y * ow + x) * 4; o.data[j] = c[0]; o.data[j + 1] = c[1]; o.data[j + 2] = c[2]; };
for (const n of r.nodes) { const c = COL[n.shape] || [120, 120, 120], x = (n.box[0] * OS) | 0, y = (n.box[1] * OS) | 0, bw = (n.box[2] * OS) | 0, bh = (n.box[3] * OS) | 0; for (let t = 0; t < 2; t++) { for (let xx = x; xx <= x + bw; xx++) { set(xx, y + t, c); set(xx, y + bh - t, c); } for (let yy = y; yy <= y + bh; yy++) { set(x + t, yy, c); set(x + bw - t, yy, c); } } }
const out = path.replace(/\.png$/, "-perceived.png"); fs.writeFileSync(out, PNG.sync.write(o));
console.log("→ " + out + ` (${ow}×${oh})  зелёный=грань/капля-карточка, циан=текст, оранж=бар, синий=round-rect`);
