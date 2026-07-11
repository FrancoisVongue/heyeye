import fs from "node:fs"; import * as I from "../src/islands.js";
const imgs = process.argv.slice(2).length ? process.argv.slice(2) : ["nytimes","clean-piano","clean-spotify","youtube"];
const time = (fn,N=12) => { fn(); const t=Date.now(); for(let i=0;i<N;i++)fn(); return (Date.now()-t)/N; };
for (const name of imgs) {
  const frame = I.decodeFrame(fs.readFileSync(`eye/shots/${name}.png`));
  const isl = time(()=>I.detect(frame,{maxW:760,maxDepth:3})), er = time(()=>I.edgeRects(frame)), sp = time(()=>I.sidePanels(frame));
  console.log(`${name.padEnd(14)} islands ${isl.toFixed(1)} + edge ${er.toFixed(1)} + panels ${sp.toFixed(1)} = ${(isl+er+sp).toFixed(1)}мс`);
}
