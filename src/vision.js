// OCR через Apple Vision (Neural Engine/GPU, on-device, ~10× быстрее tesseract, без Python).
// Тот же интерфейс, что был у ocr.js: ocr()/cropScale()/readRegion(). Зовём нативный бинарь.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";

const BIN = path.resolve("eye/bin/vision-ocr");

// pngBuffer → {W,H, lines:[{text,box,conf}], words:[{text,box,conf}]}  (box=[x,y,w,h] px)
export function ocr(pngBuffer, { fast = false } = {}) {
  const tmp = path.join(os.tmpdir(), `eye-ocr-${process.pid}-${pngBuffer.length}.png`);
  fs.writeFileSync(tmp, pngBuffer);
  try {
    const out = execFileSync(BIN, fast ? [tmp, "fast"] : [tmp], { maxBuffer: 128 * 1024 * 1024 });
    const r = JSON.parse(out.toString());
    return { W: r.width, H: r.height, lines: r.lines || [], words: r.words || [] };
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

// вырезать регион и увеличить (фовеально) → буфер + обратный пересчёт координат
export function cropScale(pngBuffer, [x, y, bw, bh], scale = 2) {
  const src = PNG.sync.read(pngBuffer);
  x = Math.max(0, x | 0); y = Math.max(0, y | 0); bw = Math.min(src.width - x, bw | 0); bh = Math.min(src.height - y, bh | 0);
  const cw = Math.max(1, Math.round(bw * scale)), ch = Math.max(1, Math.round(bh * scale));
  const out = new PNG({ width: cw, height: ch });
  for (let oy = 0; oy < ch; oy++) for (let ox = 0; ox < cw; ox++) {
    const sx = Math.min(src.width - 1, x + (ox / scale | 0)), sy = Math.min(src.height - 1, y + (oy / scale | 0));
    const si = (sy * src.width + sx) * 4, di = (oy * cw + ox) * 4;
    out.data[di] = src.data[si]; out.data[di + 1] = src.data[si + 1]; out.data[di + 2] = src.data[si + 2]; out.data[di + 3] = 255;
  }
  return { buf: PNG.sync.write(out), back: (b) => [Math.round(b[0] / scale) + x, Math.round(b[1] / scale) + y, Math.round(b[2] / scale), Math.round(b[3] / scale)] };
}

// фовеальный OCR региона (координаты слов/строк — АБСОЛЮТНЫЕ пиксели скрина)
export function readRegion(pngBuffer, box, { scale = 2 } = {}) {
  const { buf, back } = cropScale(pngBuffer, box, scale);
  const r = ocr(buf);
  return { lines: r.lines.map((l) => ({ ...l, box: back(l.box) })), words: r.words.map((w) => ({ ...w, box: back(w.box) })) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path0 = process.argv[2] || "eye/shots/raw-bbc.png";
  const t = Date.now(); const r = ocr(fs.readFileSync(path0));
  console.log(`${r.W}×${r.H} | строк ${r.lines.length} слов ${r.words.length} | ${Date.now() - t}мс`);
  r.lines.slice(0, 12).forEach((l) => console.log(`  @${l.box.join(",")} "${l.text.slice(0, 55)}"`));
}
