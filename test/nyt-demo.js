// 1) ВЫРЕЗАТЬ отдельный регион (картинку №4) из NYT.  2) ДЕТЕРМИНИЗМ: тот же скрин → тот же ответ.
import fs from "node:fs";
import { PNG } from "pngjs";
import { perceive } from "../src/routes.js";

const buf = fs.readFileSync("eye/shots/nytimes.png");
const sig = (r) => JSON.stringify(r.nodes.map((n) => [n.id, n.shape, n.box, n.text || ""]));

// два прогона на ОДНОМ файле
const r1 = await perceive(buf, new URLSearchParams(""));
const r2 = await perceive(buf, new URLSearchParams(""));
console.log(`ДЕТЕРМИНИЗМ: прогон1 = ${r1.nodes.length} узлов, прогон2 = ${r2.nodes.length}, идентично: ${sig(r1) === sig(r2) ? "ДА ✓" : "НЕТ ✗"}`);

// картинки в порядке чтения (сверху↓, слева→)
const imgs = r1.nodes.filter((n) => n.shape === "image" || n.image).sort((a, b) => (a.box[1] - b.box[1]) || (a.box[0] - b.box[0]));
console.log(`\nкартинки NYT (${imgs.length}), порядок чтения:`);
imgs.forEach((n, i) => console.log(`  #${i + 1} [id${n.id}] css@${n.box.map((v) => Math.round(v / 2)).join(",")}  (${n.box[2]}×${n.box[3]}px)`));

// вырезать #4
const t = imgs[3] || imgs[imgs.length - 1];
const png = PNG.sync.read(buf); const { width: W } = png;
const [x, y, w, h] = t.box, crop = new PNG({ width: w, height: h });
for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) { const si = ((y + yy) * W + (x + xx)) * 4, di = (yy * w + xx) * 4; crop.data[di] = png.data[si]; crop.data[di + 1] = png.data[si + 1]; crop.data[di + 2] = png.data[si + 2]; crop.data[di + 3] = 255; }
fs.writeFileSync("eye/shots/nyt-image4.png", PNG.sync.write(crop));
console.log(`\n→ вырезал КАРТИНКУ #4 [id${t.id}] ${w}×${h}px → eye/shots/nyt-image4.png`);
