// «СОЛИДИФИКАЦИЯ» текст-блоков в КНОПКИ/ЧИПЫ: если текст сидит на СПЛОШНОМ цвете, отличном от фона
// страницы (заливка кнопки/тега), расширяем блок до края этой заливки. Ловит кнопки, которые капля
// не видит (мелкие / на градиенте). CPU, без ML. Вход — png-буфер + текст-блоки (в пикселях скрина).
import { PNG } from "pngjs";

const dist = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

export function solidify(buf, blocks, { cap = 60 } = {}) {
  const png = PNG.sync.read(buf); const { width: W, height: H, data } = png;
  const at = (x, y) => { const i = ((y < 0 ? 0 : y >= H ? H - 1 : y) * W + (x < 0 ? 0 : x >= W ? W - 1 : x)) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  // фон страницы = мода по рамке (квант 4 бита)
  const hist = new Map(); const bump = (x, y) => { const c = at(x, y), k = (c[0] >> 4 << 8) | (c[1] >> 4 << 4) | c[2] >> 4; hist.set(k, (hist.get(k) || 0) + 1); };
  for (let x = 0; x < W; x += 6) { bump(x, 1); bump(x, H - 2); } for (let y = 0; y < H; y += 6) { bump(1, y); bump(W - 2, y); }
  let bk = 0, bc = -1; for (const [k, c] of hist) if (c > bc) { bc = c; bk = k; } const BG = [bk >> 8 << 4, (bk >> 4 & 15) << 4, (bk & 15) << 4];

  return blocks.map((b) => {
    let [x, y, bw, bh] = b.box; const x1 = x + bw, y1 = y + bh;
    // кольцо ЧУТЬ СНАРУЖИ блока = фон, на котором лежит текст (заливка кнопки или фон страницы)
    const ring = []; const st = Math.max(2, (bw / 20) | 0);
    for (let xx = x; xx <= x1; xx += st) { ring.push(at(xx, y - 4)); ring.push(at(xx, y1 + 4)); }
    for (let yy = y; yy <= y1; yy += st) { ring.push(at(x - 4, yy)); ring.push(at(x1 + 4, yy)); }
    // мода кольца + однородность
    const rh = new Map(); for (const c of ring) { const k = (c[0] >> 4 << 8) | (c[1] >> 4 << 4) | c[2] >> 4; rh.set(k, (rh.get(k) || 0) + 1); }
    let rk = 0, rc = -1; for (const [k, c] of rh) if (c > rc) { rc = c; rk = k; } const fill = [rk >> 8 << 4, (rk >> 4 & 15) << 4, (rk & 15) << 4];
    const uniform = rc / ring.length > 0.8; // кольцо одноцветное
    if (!uniform || dist(fill, BG) <= 24) return b; // не кнопка: на фоне страницы или пёстро
    // расширяем до края заливки. КЛЮЧ: кнопка ЗАМКНУТА — каждая сторона должна найти край В ПРЕДЕЛАХ cap.
    // если сторона упёрлась в cap (заливка тянется далеко) → это ПАНЕЛЬ, а не кнопка.
    const lineIs = (pts) => { let ok = 0; for (const [px, py] of pts) if (dist(at(px, py), fill) <= 26) ok++; return ok / pts.length > 0.7; };
    let nx0 = x, ny0 = y, nx1 = x1, ny1 = y1, hitCap = false; let k;
    for (k = 0; k < cap; k++) { const p = []; for (let xx = nx0; xx <= nx1; xx += st) p.push([xx, ny0 - 1]); if (lineIs(p)) ny0--; else break; } if (k >= cap) hitCap = true;
    for (k = 0; k < cap; k++) { const p = []; for (let xx = nx0; xx <= nx1; xx += st) p.push([xx, ny1 + 1]); if (lineIs(p)) ny1++; else break; } if (k >= cap) hitCap = true;
    for (k = 0; k < cap; k++) { const p = []; for (let yy = ny0; yy <= ny1; yy += st) p.push([nx0 - 1, yy]); if (lineIs(p)) nx0--; else break; } if (k >= cap) hitCap = true;
    for (k = 0; k < cap; k++) { const p = []; for (let yy = ny0; yy <= ny1; yy += st) p.push([nx1 + 1, yy]); if (lineIs(p)) nx1++; else break; } if (k >= cap) hitCap = true;
    if (hitCap || (nx1 - nx0) > 520 || (ny1 - ny0) > 130) return b; // заливка-панель или слишком крупно → не кнопка (оставляем текстом)
    return { ...b, box: [nx0, ny0, nx1 - nx0, ny1 - ny0], shape: "button" };
  });
}
