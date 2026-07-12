import { PNG } from "pngjs";
import fs from "node:fs";
import { perceive } from "../src/routes.js";
const COL = { button:[245,158,11], text:[14,165,183], block:[8,145,178], bar:[255,90,0], image:[230,20,200], surface:[240,160,20], rect:[22,163,74], "round-rect":[47,107,255], circle:[225,29,72], icon:[255,140,0], blob:[164,75,255] };
const name = process.argv[2], cx=+process.argv[3], cy=+process.argv[4], cw=+process.argv[5], ch=+process.argv[6], zoom=+(process.argv[7]||3);
const buf = fs.readFileSync(`eye/shots/${name}.png`);
const r = await perceive(buf, new URLSearchParams(""));
const png = PNG.sync.read(buf); const {width:W,height:H,data}=png;
// draw boxes at native res onto a copy
const set=(x,y,c)=>{if(x<0||y<0||x>=W||y>=H)return;const j=(y*W+x)*4;data[j]=c[0];data[j+1]=c[1];data[j+2]=c[2];};
for(const n of r.nodes){const c=COL[n.shape]||[120,120,120],[bx,by,bw,bh]=n.box;for(let t=0;t<1;t++){for(let xx=bx;xx<=bx+bw;xx++){set(xx,by+t,c);set(xx,by+bh-t,c);}for(let yy=by;yy<=by+bh;yy++){set(bx+t,yy,c);set(bx+bw-t,yy,c);}}}
// crop cx,cy,cw,ch and upscale zoom×
const ow=cw*zoom, oh=ch*zoom, o=new PNG({width:ow,height:oh});
for(let y=0;y<oh;y++)for(let x=0;x<ow;x++){const sx=cx+((x/zoom)|0),sy=cy+((y/zoom)|0),i=(sy*W+sx)*4,j=(y*ow+x)*4;o.data[j]=data[i];o.data[j+1]=data[i+1];o.data[j+2]=data[i+2];o.data[j+3]=255;}
const out=`eye/shots/${name}-crop.png`; fs.writeFileSync(out, PNG.sync.write(o));
console.log(`${out} ${ow}×${oh} (из ${cx},${cy},${cw},${ch} ×${zoom})`);
