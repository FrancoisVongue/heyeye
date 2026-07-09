// OCR: скриншот(пиксели) → текст с координатами. Чистый JS/WASM (tesseract.js), НОЛЬ Python.
// Даёт и строки, и слова (для выделения произвольного текста мышью). Фовеальный режим:
// вырезаем РЕГИОН и увеличиваем → мелкий текст читается чётко, координаты возвращаем абсолютные.
import { createWorker } from "tesseract.js";
import { PNG } from "pngjs";

// воркер держим в globalThis, чтобы он переживал hot-reload модуля (fresh-импорт) и не пересоздавался
export async function load(langs = "eng") { if (!globalThis.__eyeOcr) globalThis.__eyeOcr = await createWorker(langs); return globalThis.__eyeOcr; }
export async function done() { if (globalThis.__eyeOcr) { await globalThis.__eyeOcr.terminate(); globalThis.__eyeOcr = null; } }

// один проход → {W,H, lines:[{text,box,conf}], words:[{text,box,conf}]}  (box = [x,y,w,h] в пикселях картинки)
export async function ocr(pngBuffer) {
  const w = await load();
  const { width: W, height: H } = PNG.sync.read(pngBuffer);
  const { data } = await w.recognize(pngBuffer, {}, { blocks: true });
  const lines = [], words = [];
  const mk = (text, bb, conf) => { const t = (text || "").replace(/\s+/g, " ").trim(); return t && bb ? { text: t, box: [bb.x0, bb.y0, bb.x1 - bb.x0, bb.y1 - bb.y0], conf: Math.round(conf || 0) } : null; };
  for (const b of (data.blocks || [])) for (const p of (b.paragraphs || [])) for (const l of (p.lines || [])) {
    const L = mk(l.text, l.bbox, l.confidence); if (L) lines.push(L);
    for (const wd of (l.words || [])) { const Wd = mk(wd.text, wd.bbox, wd.confidence); if (Wd) words.push(Wd); }
  }
  return { W, H, lines, words };
}

// вырезать регион и увеличить (фовеально) → png-буфер + функция обратного пересчёта координат
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

// фовеальный OCR региона (координаты слов/строк — в АБСОЛЮТНЫХ пикселях исходного скрина)
export async function readRegion(pngBuffer, box, { scale = 2.5 } = {}) {
  const { buf, back } = cropScale(pngBuffer, box, scale);
  const r = await ocr(buf);
  return { lines: r.lines.map((l) => ({ ...l, box: back(l.box) })), words: r.words.map((wd) => ({ ...wd, box: back(wd.box) })) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import("node:fs");
  const path = process.argv[2] || "eye/shots/complex-clean.png";
  const t0 = Date.now();
  const r = await ocr(fs.readFileSync(path));
  console.log(`${r.W}×${r.H} | строк ${r.lines.length} слов ${r.words.length} | ${((Date.now() - t0) / 1000).toFixed(1)}с`);
  r.lines.slice(0, 20).forEach((l, i) => console.log(`  [${i + 1}] @${l.box.join(",")} "${l.text.slice(0, 60)}"`));
  await done();
}
