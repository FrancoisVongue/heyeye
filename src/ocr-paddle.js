// OCR через PaddleOCR (PP-OCRv5, onnxruntime-node) — БЕЗ Python, БЕЗ Apple, детерминированно, кириллица.
// Модель ESlav = русский+английский. Тот же интерфейс, что vision.js: ocrAsync(buf) → {W,H,lines,words}.
// Сервис (модель в памяти) живёт на globalThis — переживает hot-reload routes.js, грузится один раз.
import { PaddleOcrService, V5_ESLAV_MOBILE_MODEL } from "ppu-paddle-ocr";

function service() {
  if (!globalThis.__paddleOcr) {
    const s = new PaddleOcrService({ model: V5_ESLAV_MOBILE_MODEL });
    globalThis.__paddleOcr = { s, ready: s.initialize() }; // ready — промис первичной загрузки модели
  }
  return globalThis.__paddleOcr;
}
const dimsPNG = (buf) => ({ W: buf.readUInt32BE(16), H: buf.readUInt32BE(20) }); // размеры из IHDR, без декода

// pngBuffer → {W,H, lines:[], words:[{text,box:[x,y,w,h],conf}]}  (координаты в px скрина)
export async function ocrAsync(pngBuffer) {
  const { s, ready } = service();
  await ready;
  const ab = pngBuffer.buffer.slice(pngBuffer.byteOffset, pngBuffer.byteOffset + pngBuffer.byteLength);
  const r = await s.recognize(ab);
  const words = [];
  for (const line of r.lines || []) for (const seg of (Array.isArray(line) ? line : [line])) {
    if (seg && seg.box && seg.text) words.push({ text: seg.text, box: [seg.box.x | 0, seg.box.y | 0, seg.box.width | 0, seg.box.height | 0], conf: Math.round((seg.confidence || 0) * 100) });
  }
  return { ...dimsPNG(pngBuffer), lines: [], words };
}
export const ocr = ocrAsync; // синоним (обе версии асинхронные)

// РАСПОЗНАВАНИЕ одного кропа (для ленивого /read по региону) — то же, но на маленькой картинке (быстро)
export async function recognizeCrop(pngBuffer) { return ocrAsync(pngBuffer); }
