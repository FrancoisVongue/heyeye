import fs from "node:fs";
import { PaddleOcrService, V5_ESLAV_MOBILE_MODEL } from "ppu-paddle-ocr";
const toAB=b=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
const s=new PaddleOcrService({model:V5_ESLAV_MOBILE_MODEL});
await s.initialize();
await s.recognize(toAB(fs.readFileSync("eye/shots/clean-bbc.png"))); // прогрев
for(const name of ["nytimes","youtube","clean-spotify"]){
  const ab=toAB(fs.readFileSync(`eye/shots/${name}.png`));
  const canvas=await s.platform.canvas.prepareCanvas(ab);
  const td=Date.now(); const boxes=await s.detector.run(canvas); const detMs=Date.now()-td;
  const tf=Date.now(); await s.recognize(ab,{noCache:true}); const fullMs=Date.now()-tf;
  console.log(`${name.replace('clean-','').padEnd(9)} детекция=${detMs}мс (${boxes.length} боксов) | полный OCR=${fullMs}мс → распознавание≈${fullMs-detMs}мс`);
}
