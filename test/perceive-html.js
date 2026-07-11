// Полный perceive() офлайн → HTML-страница со скрином и РАЗМЕТКОЙ (боксы+подписи), как /snap, но без
// демона. Открываем в браузере, чтобы посмотреть глазами.  node eye/test/perceive-html.js [png]
import fs from "node:fs";
import path from "node:path";
import { perceive } from "../src/routes.js";

const COL = { button: "#f59e0b", text: "#0ea5b7", block: "#0891b2", bar: "#ff5a00", image: "#e614c8", surface: "#f0a014", rect: "#16a34a", "round-rect": "#2f6bff", circle: "#e11d48", blob: "#a44bff" };
const src = process.argv[2] || "eye/shots/clean-piano.png";
const buf = fs.readFileSync(src);
const r = await perceive(buf, new URLSearchParams(""));
const dpr = 2;                                   // скрин Retina 2x → css = px/2
const cssW = Math.round(r.W / dpr), cssH = Math.round(r.H / dpr);
const by = {}; for (const n of r.nodes) by[n.shape] = (by[n.shape] || 0) + 1;
const boxes = r.nodes.map((n) => {
  const x = Math.round(n.box[0] / dpr), y = Math.round(n.box[1] / dpr), w = Math.round(n.box[2] / dpr), h = Math.round(n.box[3] / dpr);
  const c = COL[n.shape] || "#888", dash = n.shape === "surface";
  return `<div class="b" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;border:1.5px ${dash ? "dashed" : "solid"} ${c}"><span style="background:${c}">${n.id} ${n.shape}</span></div>`;
}).join("");
const html = `<!doctype html><meta charset="utf-8"><title>perceive ${path.basename(src)}</title>
<style>html,body{margin:0;background:#111}#w{position:relative;width:${cssW}px}#w>img{display:block;width:${cssW}px;height:${cssH}px}
.b{position:absolute;box-sizing:border-box;pointer-events:none;font:9px/1 ui-monospace,monospace}
.b>span{position:absolute;left:-1px;top:-11px;color:#fff;padding:0 3px;border-radius:2px;white-space:nowrap;opacity:.9}
#legend{position:fixed;right:8px;top:8px;background:#000c;color:#fff;font:12px/1.5 ui-monospace,monospace;padding:8px 10px;border-radius:6px;z-index:9}</style>
<div id="legend">${r.nodes.length} узлов · ${JSON.stringify(by)}<br>зелёный rect=карточка · циан text · оранж bar · синий round-rect · маджента image</div>
<div id="w"><img src="data:image/png;base64,${buf.toString("base64")}">${boxes}</div>`;
const out = "eye/page/perceived-" + path.basename(src).replace(/\.png$/, "") + ".html";
fs.writeFileSync(out, html);
console.log(`${r.nodes.length} узлов (${r.mode}) ${JSON.stringify(by)} → ${out}`);
console.log("file://" + path.resolve(out));
