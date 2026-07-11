// Замер времени: полный perceive() и по стадиям, на разных скринах.
import fs from "node:fs";
import { perceive } from "../src/routes.js";
import * as I from "../src/islands.js";
import { textBlocks } from "../src/textgroup.js";

for (const site of ["nytimes", "youtube", "clean-piano"]) {
  const buf = fs.readFileSync(`eye/shots/${site}.png`);
  const png = (await import("pngjs")).PNG.sync.read(buf);
  await perceive(buf, new URLSearchParams(""));                 // прогрев
  const t0 = Date.now(); const r = await perceive(buf, new URLSearchParams("")); const full = Date.now() - t0;
  const a = Date.now(); I.detect(buf, { tol: 12, maxDepth: 3 }); const isl = Date.now() - a;
  const b = Date.now(); await textBlocks(buf); const ocr = Date.now() - b;
  const c = Date.now(); I.edgeRects(buf); const er = Date.now() - c;
  const d = Date.now(); I.sidePanels(buf); const sp = Date.now() - d;
  console.log(`${site.padEnd(12)} ${png.width}×${png.height}px, ${r.nodes.length} узлов:  ПОЛНЫЙ ${full}мс  =  островки ${isl} + OCR ${ocr} + грань ${er} + панели ${sp} + прочее ${full - isl - ocr - er - sp}`);
}
