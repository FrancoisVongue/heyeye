// GOLDEN-ГЕЙТ качества CV (нулевая толерантность). Снимает точный выход islands.detect + edgeRects
// (ОБА arg-set: обычный и canvasy) + sidePanels на наборе скринов и сравнивает посимвольно с эталоном.
// Отпечаток detect включает shape/box/image/parent/colors/edge — полный фингерпринт узла.
//   node eye/test/cvgolden.js save   — записать эталон (на текущем закоммиченном коде!)
//   node eye/test/cvgolden.js check  — сравнить текущий код с эталоном (exit 1 при любом расхождении)
import fs from "node:fs";
import * as I from "../src/islands.js";

const IMAGES = ["nytimes", "youtube", "clean-piano", "clean-complex", "clean-yahoo", "clean-bbc", "clean-spotify"];
const GOLD = "eye/test/cv-golden.json";
const box = (b) => `${b[0]},${b[1]},${b[2]},${b[3]}`;

function cvOf(png) {
  const frame = I.decodeFrame(fs.readFileSync(png));
  const det = I.detect(frame, { tol: 12, maxDepth: 3 }).nodes.map((n) => `${n.shape}|${box(n.box)}|${n.image ? 1 : 0}|p${n.parent}|c${n.colors}|e${n.edge}`).sort();
  const edge = I.edgeRects(frame, {}).rects.map((r) => box(r.box)).sort();                                  // обычный набор параметров
  const edgeC = I.edgeRects(frame, { perimMin: 0.4, emptyMin: 0.1 }).rects.map((r) => box(r.box)).sort();   // canvasy набор (perceive выбирает по сайту)
  const pan = I.sidePanels(frame, {}).panels.map((p) => box(p.box)).sort();
  return { det, edge, edgeC, pan };
}

const mode = process.argv[2] || "check";
const cur = {};
for (const name of IMAGES) { const p = `eye/shots/${name}.png`; if (fs.existsSync(p)) cur[name] = cvOf(p); }

if (mode === "save") {
  fs.writeFileSync(GOLD, JSON.stringify(cur));
  const tot = Object.values(cur).reduce((s, v) => s + v.det.length + v.edge.length + v.edgeC.length + v.pan.length, 0);
  console.log(`эталон записан: ${Object.keys(cur).length} картинок, ${tot} CV-элементов → ${GOLD}`);
  for (const [n, v] of Object.entries(cur)) console.log(`  ${n.padEnd(14)} detect ${v.det.length}, edge ${v.edge.length}, edgeC ${v.edgeC.length}, panels ${v.pan.length}`);
} else {
  const gold = JSON.parse(fs.readFileSync(GOLD, "utf8"));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const diff = (a, b) => { const B = new Set(b), A = new Set(a); return { lost: a.filter((x) => !B.has(x)), gained: b.filter((x) => !A.has(x)) }; };
  let ok = 0, bad = 0;
  for (const name of Object.keys(gold)) {
    const g = gold[name], c = cur[name];
    if (!c) { console.log(`  ? ${name}: нет картинки`); continue; }
    const keys = ["det", "edge", "edgeC", "pan"];
    const fails = keys.filter((k) => !same(g[k], c[k]));
    if (!fails.length) { ok++; console.log(`  ✓ ${name}`); }
    else {
      bad++;
      console.log(`  ✗ ${name}: ` + fails.map((k) => { const d = diff(g[k], c[k]); return `${k}(-${d.lost.length}/+${d.gained.length})`; }).join(" "));
      fails.forEach((k) => { const d = diff(g[k], c[k]); if (d.lost.length) console.log(`      ${k} ПОТЕРЯНЫ:`, d.lost.slice(0, 3)); if (d.gained.length) console.log(`      ${k} ЛИШНИЕ:`, d.gained.slice(0, 3)); });
    }
  }
  console.log(`\nИТОГ: ${ok} совпало, ${bad} разошлось${bad === 0 ? "  ✅ КАЧЕСТВО СОХРАНЕНО" : "  ⚠️ РЕГРЕССИЯ"}`);
  process.exit(bad === 0 ? 0 : 1);
}
