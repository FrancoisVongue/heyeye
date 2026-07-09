// ПЕРЕКРЫТИЕ через КАПЛЮ + СТЕНЫ. CPU, без ML. Идея юзера:
//   капля растекается, ЛОМАЕТСЯ на резком переходе/тени (долина), но НЕ на градиенте.
//   Перекрытые окна разделяются, и видимая форма перекрытого окна — БУКВА L (не прямоугольник).
//   Низкое заполнение bbox → L-форма → окно ПЕРЕКРЫТО; пустой угол bbox = ГДЕ перекрыто.
import { PNG } from "pngjs";
import fs from "node:fs";

const PAL = [[230, 40, 40], [40, 190, 70], [50, 110, 240], [240, 170, 0], [190, 40, 200], [0, 180, 190]];

export function detectShapes(buf, { maxW = 900, valleyM = 5, edgeT = 20, minFrac = 0.004 } = {}) {
  const png = PNG.sync.read(buf); const { width: W, height: H, data } = png;
  const s = Math.min(1, maxW / W), w = (W * s) | 0, h = (H * s) | 0, d = 3;
  const L = new Float32Array(w * h), RGB = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (((y / s) | 0) * W + ((x / s) | 0)) * 4, j = y * w + x; RGB[j * 3] = data[i]; RGB[j * 3 + 1] = data[i + 1]; RGB[j * 3 + 2] = data[i + 2]; L[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; }
  // ФОН/BACKDROP = самый частый цвет по рамке (десктоп/подложка). Окно = «не фон» (вкл. тёмный заголовок).
  const hist = new Map(); const addc = (x, y) => { const j = (y * w + x) * 3, k = ((RGB[j] >> 3) << 10) | ((RGB[j + 1] >> 3) << 5) | (RGB[j + 2] >> 3); hist.set(k, (hist.get(k) || 0) + 1); };
  for (let x = 0; x < w; x++) { addc(x, 0); addc(x, h - 1); } for (let y = 0; y < h; y++) { addc(0, y); addc(w - 1, y); }
  let bk = 0, bc = -1; for (const [k, c] of hist) if (c > bc) { bc = c; bk = k; } const BG = [((bk >> 10) & 31) << 3, ((bk >> 5) & 31) << 3, (bk & 31) << 3];
  const isFg = (j) => Math.max(Math.abs(RGB[j * 3] - BG[0]), Math.abs(RGB[j * 3 + 1] - BG[1]), Math.abs(RGB[j * 3 + 2] - BG[2])) > 40;
  // ЯДРО окна ловим по СВЕТЛОМУ телу (стабильно), заголовок/тёмное достроим потом. СТЕНА = долина(тень/бордер) ИЛИ резкий край.
  const isBody = (j) => L[j] > 150 && isFg(j);
  const wall0 = new Uint8Array(w * h);
  for (let y = d; y < h - d; y++) for (let x = d; x < w - d; x++) {
    const c = L[y * w + x];
    const valley = (L[y * w + x - d] - c > valleyM && L[y * w + x + d] - c > valleyM) || (L[(y - d) * w + x] - c > valleyM && L[(y + d) * w + x] - c > valleyM);
    const edge = Math.abs(L[y * w + x + 1] - L[y * w + x - 1]) > edgeT || Math.abs(L[(y + 1) * w + x] - L[(y - 1) * w + x]) > edgeT;
    if (valley || edge) wall0[y * w + x] = 1;
  }
  // утолщаем стены на 1px — закрываем щели, чтобы капля не протекала в соседнее окно
  const wall = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (wall0[y * w + x] || wall0[y * w + x - 1] || wall0[y * w + x + 1] || wall0[(y - 1) * w + x] || wall0[(y + 1) * w + x]) wall[y * w + x] = 1;
  // заливка СВЕТЛЫХ тел, НЕ пересекая стены
  const lab = new Int32Array(w * h).fill(-1), q = new Int32Array(w * h); let id = 0; const info = [];
  for (let s0 = 0; s0 < w * h; s0++) {
    if (lab[s0] !== -1 || !isBody(s0) || wall[s0]) continue;
    lab[s0] = id; let head = 0, tail = 0; q[tail++] = s0; let n = 0, x0 = s0 % w, y0 = (s0 / w) | 0, x1 = x0, y1 = y0;
    while (head < tail) { const pp = q[head++], px = pp % w, py = (pp / w) | 0; n++; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; const t = (nn) => { if (lab[nn] === -1 && isBody(nn) && !wall[nn]) { lab[nn] = id; q[tail++] = nn; } }; if (px + 1 < w) t(pp + 1); if (px - 1 >= 0) t(pp - 1); if (py + 1 < h) t(pp + w); if (py - 1 >= 0) t(pp - w); }
    info.push({ id, n, x0, y0, x1, y1 }); id++;
  }
  const minN = minFrac * w * h;
  const big = info.filter((v) => v.n > minN).sort((a, b) => b.n - a.n).slice(0, 6);
  const idx = new Map(big.map((v, i) => [v.id, i]));

  // оверлей RGBA (полупрозрачные формы) + анализ формы каждого региона
  const ov = new PNG({ width: w, height: h });
  for (let i = 0; i < ov.data.length; i++) ov.data[i] = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const j = y * w + x; if (idx.has(lab[j])) { const c = PAL[idx.get(lab[j]) % PAL.length], o = j * 4; ov.data[o] = c[0]; ov.data[o + 1] = c[1]; ov.data[o + 2] = c[2]; ov.data[o + 3] = 120; } }

  // РАСШИРЯЕМ бокс тела наружу → захватываем БОРДЕР и тёмный ЗАГОЛОВОК (это части того же окна),
  // но останавливаемся на ФОНЕ или на ДРУГОМ окне (его метка). Так бокс = ПОЛНОЕ окно, по самой границе.
  const okLine = (pts, id) => { let ok = 0, other = 0; for (const j of pts) { if (lab[j] >= 0 && lab[j] !== id) other++; else if (isFg(j)) ok++; } return other / pts.length < 0.2 && ok / pts.length > 0.4; };
  const expand = (r) => {
    let { id, x0, y0, x1, y1 } = r; const cap = 40 * s;
    for (let k = 0; k < cap && y0 > 0; k++) { const p = []; for (let x = x0; x <= x1; x += 2) p.push((y0 - 1) * w + x); if (okLine(p, id)) y0--; else break; }
    for (let k = 0; k < cap && y1 < h - 1; k++) { const p = []; for (let x = x0; x <= x1; x += 2) p.push((y1 + 1) * w + x); if (okLine(p, id)) y1++; else break; }
    for (let k = 0; k < cap && x0 > 0; k++) { const p = []; for (let y = y0; y <= y1; y += 2) p.push(y * w + x0 - 1); if (okLine(p, id)) x0--; else break; }
    for (let k = 0; k < cap && x1 < w - 1; k++) { const p = []; for (let y = y0; y <= y1; y += 2) p.push(y * w + x1 + 1); if (okLine(p, id)) x1++; else break; }
    return { ...r, x0, y0, x1, y1 };
  };
  big.forEach((r, i) => { const e = expand(r); r.x0 = e.x0; r.y0 = e.y0; r.x1 = e.x1; r.y1 = e.y1; });

  // считаем ПЕРЕКРЫТИЯ через пересечение прямоугольников + голосование по z-order:
  // в зоне пересечения двух окон чьи пиксели видны (метка), тот СВЕРХУ; другому эта зона = «перекрыто».
  const win = big.map((r) => ({ id: r.id, x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, fill: r.n / ((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1)), occ: [] }));
  for (let i = 0; i < win.length; i++) for (let j = i + 1; j < win.length; j++) {
    const A = win[i], B = win[j];
    const ix0 = Math.max(A.x0, B.x0), iy0 = Math.max(A.y0, B.y0), ix1 = Math.min(A.x1, B.x1), iy1 = Math.min(A.y1, B.y1);
    if (ix1 - ix0 < 12 * s || iy1 - iy0 < 12 * s) continue;               // нет заметного пересечения
    let ca = 0, cb = 0; for (let y = iy0; y <= iy1; y += 2) for (let x = ix0; x <= ix1; x += 2) { const L2 = lab[y * w + x]; if (L2 === A.id) ca++; else if (L2 === B.id) cb++; }
    const bottom = ca >= cb ? B : A;                                       // у кого меньше видимых пикселей в зоне — тот снизу
    bottom.occ.push([ix0, iy0, ix1 - ix0, iy1 - iy0]);
  }
  const regions = win.map((r, i) => ({
    color: "#" + PAL[i % PAL.length].map((v) => v.toString(16).padStart(2, "0")).join(""),
    box: [Math.round(r.x0 / s), Math.round(r.y0 / s), Math.round((r.x1 - r.x0 + 1) / s), Math.round((r.y1 - r.y0 + 1) / s)],
    fill: +r.fill.toFixed(2), occluded: r.occ.length > 0,
    occBoxes: r.occ.map((b) => [Math.round(b[0] / s), Math.round(b[1] / s), Math.round(b[2] / s), Math.round(b[3] / s)]),
  }));
  return { W: Math.round(w / s), H: Math.round(h / s), overlayPng: PNG.sync.write(ov), regions };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] || "eye/shots/overlap-clean.png";
  const r = detectShapes(fs.readFileSync(path));
  console.log(`${r.regions.length} окон (${r.W}×${r.H}):`);
  r.regions.forEach((g, i) => console.log(`  [${i + 1}] ПОЛНЫЙ прямоуг @${g.box.join(",")} fill=${g.fill}` + (g.occBoxes.length ? `  · перекрыто: ${g.occBoxes.map((b) => "@" + b.join(",")).join(" ")}` : " · сверху (видно целиком)")));
}
