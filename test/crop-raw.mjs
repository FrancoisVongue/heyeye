import { PNG } from "pngjs";
import fs from "node:fs";
const [,,inp,out,cx,cy,cw,ch] = process.argv.map((v,i)=>i>=4?+v:v);
const src = PNG.sync.read(fs.readFileSync(inp));
const o = new PNG({width:cw,height:ch});
for (let y=0;y<ch;y++) for (let x=0;x<cw;x++){ const si=((cy+y)*src.width+(cx+x))*4, di=(y*cw+x)*4; o.data[di]=src.data[si];o.data[di+1]=src.data[si+1];o.data[di+2]=src.data[si+2];o.data[di+3]=255; }
fs.writeFileSync(out, PNG.sync.write(o));
console.log(`${out} ${cw}×${ch}`);
