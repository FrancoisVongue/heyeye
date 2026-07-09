// Синтетическая тест-картинка с ЭТАЛОННЫМИ фигурами (известная правда) — чтобы калибровать
// детектор форм. Прямоугольник, скруглённые прямоугольники (разный радиус), круг, и ВЛОЖЕННЫЙ
// прямоугольник (прямоугольник в прямоугольнике).
import { PNG } from "pngjs";
import fs from "node:fs";

const W = 980, H = 640, png = new PNG({ width: W, height: H });
for (let i = 0; i < W * H; i++) { png.data[i * 4] = 245; png.data[i * 4 + 1] = 246; png.data[i * 4 + 2] = 248; png.data[i * 4 + 3] = 255; } // фон
const set = (x, y, c) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; png.data[i] = c[0]; png.data[i + 1] = c[1]; png.data[i + 2] = c[2]; };
const rect = (x, y, w, h, c) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) set(xx, yy, c); };
const rrect = (x, y, w, h, r, c) => { for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) { const cx = Math.min(xx, w - 1 - xx), cy = Math.min(yy, h - 1 - yy); if (cx < r && cy < r) { const dx = r - cx, dy = r - cy; if (dx * dx + dy * dy > r * r) continue; } set(x + xx, y + yy, c); } };
const circ = (cx, cy, r, c) => { for (let yy = -r; yy <= r; yy++) for (let xx = -r; xx <= r; xx++) if (xx * xx + yy * yy <= r * r) set(cx + xx, cy + yy, c); };

// имитация ТЕКСТА: строки мелких «букв» разного цвета (каждая < minArea → должна игнорироваться)
const text = (x, y, cols, rows, c) => { for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) { const bx = x + k * 13, by = y + r * 17; for (let dy = 0; dy < 9; dy++) for (let dx = 0; dx < 7; dx++) if ((dx + dy) % 3) set(bx + dx, by + dy, c); } };

rect(60, 70, 240, 150, [60, 110, 220]);                 // 1. прямоугольник
text(80, 110, 12, 3, [240, 240, 240]);                  //    + белый текст поверх него
rrect(360, 70, 250, 150, 30, [40, 170, 90]);            // 2. скруглённый (радиус 30)
text(380, 110, 12, 3, [20, 40, 20]);                    //    + тёмный текст поверх него
rrect(680, 70, 220, 150, 70, [200, 130, 30]);           // 3. сильно скруглённый (радиус 70)
circ(790, 470, 90, [220, 60, 60]);                      // 4. круг

rect(60, 330, 320, 250, [235, 200, 60]);                // 5. внешний прямоугольник …
rect(110, 380, 220, 150, [120, 160, 255]);              //    … с ВЛОЖЕННЫМ прямоугольником внутри
rrect(430, 330, 240, 160, 40, [150, 90, 220]);          // 6. ещё скруглённый

fs.mkdirSync("eye/test", { recursive: true });
fs.writeFileSync("eye/test/shapes.png", PNG.sync.write(png));
console.log("→ eye/test/shapes.png (2 прямоуг, 2 скругл, 1 сильно-скругл, 1 круг, 1 вложенный)");
