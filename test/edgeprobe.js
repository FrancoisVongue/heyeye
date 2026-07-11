// ПРОБА варианта B: капля-фон упирается в ГРАНИ. Заливаем «улицу» (фон) от рамки, НЕ пересекая
// грани (стены). Всё, куда фон НЕ добрался, — замкнутые карманы = карточки (даже если их заливка
// того же цвета, что холст: их отделяет тонкая грань-рамка). Карточка = связный не-залитый блоб
// (рамка+нутро связны сами с собой), берём bbox.
import { PNG } from "pngjs";
import fs from "node:fs";

const path = process.argv[2] || "eye/shots/clean-piano.png";
const maxW = +(process.argv[3] || 1577);
const T = +(process.argv[4] || 12);      // порог грани (|Δ яркости| соседей)
const dil = +(process.argv[5] || 1);      // утолщение стен (закрыть щели в рамках)

const png = PNG.sync.read(fs.readFileSync(path));
const { width: W, height: H, data } = png;
const s = Math.min(1, maxW / W), w = (W * s) | 0, h = (H * s) | 0;
const L = new Float32Array(w * h);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (((y / s) | 0) * W + ((x / s) | 0)) * 4; L[y * w + x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; }

const t0 = Date.now();
// СТЕНЫ = сильный градиент к любому 4-соседу
let wall = new Uint8Array(w * h);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = y * w + x; let e = 0;
  if (x + 1 < w && Math.abs(L[i] - L[i + 1]) > T) e = 1;
  else if (y + 1 < h && Math.abs(L[i] - L[i + w]) > T) e = 1;
  else if (x > 0 && Math.abs(L[i] - L[i - 1]) > T) e = 1;
  else if (y > 0 && Math.abs(L[i] - L[i - w]) > T) e = 1;
  wall[i] = e;
}
for (let d = 0; d < dil; d++) { // дилатация стен: закрыть 1px щели в рамке, чтобы фон не протёк внутрь
  const nw = wall.slice();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (wall[i]) continue; if ((x + 1 < w && wall[i + 1]) || (x > 0 && wall[i - 1]) || (y + 1 < h && wall[i + w]) || (y > 0 && wall[i - w])) nw[i] = 1; }
  wall = nw;
}
// ЗАЛИВКА фона (region 1) от рамки по НЕ-стенам
const lab = new Int32Array(w * h); const q = [];
const seed = (i) => { if (!wall[i] && !lab[i]) { lab[i] = 1; q.push(i); } };
for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
let head = 0;
while (head < q.length) { const p = q[head++], x = p % w, y = (p / w) | 0; if (x + 1 < w) seed(p + 1); if (x > 0) seed(p - 1); if (y + 1 < h) seed(p + w); if (y > 0) seed(p - w); }
// ЗАМКНУТЫЕ карманы = связные компоненты (lab!=1) по ВСЕМ пикселям (стены входят — рамка связывает нутро)
const comp = new Int32Array(w * h); let nc = 0; const boxes = [];
for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) {
  const s0 = sy * w + sx; if (lab[s0] === 1 || comp[s0]) continue;
  nc++; const cq = [s0]; comp[s0] = nc; let hh = 0, x0 = sx, y0 = sy, x1 = sx, y1 = sy, area = 0;
  while (hh < cq.length) {
    const p = cq[hh++], x = p % w, y = (p / w) | 0; area++;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    const tN = (n) => { if (lab[n] !== 1 && !comp[n]) { comp[n] = nc; cq.push(n); } };
    if (x + 1 < w) tN(p + 1); if (x > 0) tN(p - 1); if (y + 1 < h) tN(p + w); if (y > 0) tN(p - w);
  }
  boxes.push({ x0, y0, x1, y1, area, fill: area / ((x1 - x0 + 1) * (y1 - y0 + 1)) });
}
// ОПОРА ПЕРИМЕТРА: доля 4 сторон bbox, лежащая на стене (±2px). Настоящая карточка = замкнутая
// рамка → опора высокая. Текст-блоб / рыхлая группа → низкая. Так отсекаем «Before release» и группы.
const onWall = (x, y) => { for (let d = -2; d <= 2; d++) { if (x + d >= 0 && x + d < w && wall[y * w + x + d]) return 1; if (y + d >= 0 && y + d < h && wall[(y + d) * w + x]) return 1; } return 0; };
const perim = (b) => { let c = 0, n = 0; for (let x = b.x0; x <= b.x1; x += 2) { n += 2; c += onWall(x, b.y0); c += onWall(x, b.y1); } for (let y = b.y0; y <= b.y1; y += 2) { n += 2; c += onWall(b.x0, y); c += onWall(b.x1, y); } return c / (n || 1); };
// КРУПНОЕ ПУСТОЕ НУТРО: у карточки внутри рамки есть большая СВЯЗНАЯ пустая заливка (не-стена),
// даже если есть подпись. У жирного текста «Before release» — сплошные глифы, крупной пустоты нет.
// Доля = площадь наибольшей связной не-стенной области внутри (вставка 4px) / площадь нутра.
const emptyFrac = (b) => {
  const ix0 = b.x0 + 4, iy0 = b.y0 + 4, ix1 = b.x1 - 4, iy1 = b.y1 - 4; if (ix1 <= ix0 || iy1 <= iy0) return 0;
  const bw = ix1 - ix0 + 1, seenL = new Uint8Array(bw * (iy1 - iy0 + 1)); let best = 0; const st = [];
  for (let sy = iy0; sy <= iy1; sy++) for (let sx = ix0; sx <= ix1; sx++) {
    const li = (sy - iy0) * bw + (sx - ix0); if (seenL[li] || wall[sy * w + sx]) continue;
    st.length = 0; st.push(sx, sy); seenL[li] = 1; let a = 0;
    while (st.length) { const y = st.pop(), x = st.pop(); a++;
      const tN = (nx, ny) => { if (nx < ix0 || nx > ix1 || ny < iy0 || ny > iy1) return; const l = (ny - iy0) * bw + (nx - ix0); if (!seenL[l] && !wall[ny * w + nx]) { seenL[l] = 1; st.push(nx, ny); } };
      tN(x + 1, y); tN(x - 1, y); tN(x, y + 1); tN(x, y - 1);
    }
    if (a > best) best = a;
  }
  return best / (bw * (iy1 - iy0 + 1));
};
const minSide = 34 * s;
let cards = boxes.filter((b) => (b.x1 - b.x0) > minSide && (b.y1 - b.y0) > minSide && b.area > (44 * 44) * s * s && b.fill > 0.5);
cards.forEach((b) => { b.perim = perim(b); b.empty = emptyFrac(b); });
cards = cards.filter((b) => b.perim > 0.5 && b.empty > 0.3);
cards.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
console.log(`${cards.length} карточек / ${boxes.length} карманов (maxW=${maxW} T=${T} dil=${dil}, ${w}×${h}) за ${Date.now() - t0}мс`);
cards.slice(0, 40).forEach((b, i) => console.log(`  [${i + 1}] @${Math.round(b.x0 / s)},${Math.round(b.y0 / s)} ${Math.round((b.x1 - b.x0) / s)}×${Math.round((b.y1 - b.y0) / s)} perim=${b.perim.toFixed(2)} empty=${b.empty.toFixed(2)}`));

// оверлей на уменьшенной копии (чтоб Read увидел)
const OS = 900 / W, ow = (W * OS) | 0, oh = (H * OS) | 0, o = new PNG({ width: ow, height: oh });
for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) { const i = (((y / OS) | 0) * W + ((x / OS) | 0)) * 4, j = (y * ow + x) * 4; o.data[j] = data[i]; o.data[j + 1] = data[i + 1]; o.data[j + 2] = data[i + 2]; o.data[j + 3] = 255; }
const set = (x, y, c) => { if (x < 0 || y < 0 || x >= ow || y >= oh) return; const j = (y * ow + x) * 4; o.data[j] = c[0]; o.data[j + 1] = c[1]; o.data[j + 2] = c[2]; };
cards.forEach((b) => { const x = (b.x0 / s * OS) | 0, y = (b.y0 / s * OS) | 0, bw = ((b.x1 - b.x0) / s * OS) | 0, bh = ((b.y1 - b.y0) / s * OS) | 0; for (let t = 0; t < 2; t++) { for (let xx = x; xx <= x + bw; xx++) { set(xx, y + t, [230, 30, 30]); set(xx, y + bh - t, [230, 30, 30]); } for (let yy = y; yy <= y + bh; yy++) { set(x + t, yy, [230, 30, 30]); set(x + bw - t, yy, [230, 30, 30]); } } });
const out = path.replace(/\.png$/, "-probe.png"); fs.writeFileSync(out, PNG.sync.write(o)); console.log("→ " + out);
