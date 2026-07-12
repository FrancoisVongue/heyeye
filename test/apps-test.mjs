// Прогон полного perceive() на скринах сложного проф-софта (DaVinci/Blender/Kdenlive/GIMP) + оверлеи.
import { PNG } from "pngjs";
import fs from "node:fs";
import { perceive } from "../src/routes.js";
const COL = { button:[245,158,11], text:[14,165,183], block:[8,145,178], bar:[255,90,0], image:[230,20,200], surface:[240,160,20], rect:[22,163,74], "round-rect":[47,107,255], circle:[225,29,72], icon:[255,140,0], blob:[164,75,255] };
const names = process.argv.slice(2).length ? process.argv.slice(2) : ["app-davinci","app-blender","app-kdenlive","app-gimp"];
for (const name of names) {
  const path = `eye/shots/${name}.png`;
  const buf = fs.readFileSync(path);
  const t = Date.now(); const r = await perceive(buf, new URLSearchParams("")); const ms = Date.now()-t;
  const by = {}; for (const n of r.nodes) by[n.shape]=(by[n.shape]||0)+1;
  const icons = r.nodes.filter(n=>n.shape==="circle"||n.shape==="icon").length;
  console.log(`${name.padEnd(13)} ${ms}мс  ${r.nodes.length} узлов (${r.mode})  икон(circle+icon)=${icons}  ${JSON.stringify(by)}`);
  const png = PNG.sync.read(buf); const {width:W,height:H,data}=png;
  const OS=1400/W, ow=(W*OS)|0, oh=(H*OS)|0, o=new PNG({width:ow,height:oh});
  for(let y=0;y<oh;y++)for(let x=0;x<ow;x++){const i=(((y/OS)|0)*W+((x/OS)|0))*4,j=(y*ow+x)*4;o.data[j]=data[i];o.data[j+1]=data[i+1];o.data[j+2]=data[i+2];o.data[j+3]=255;}
  const set=(x,y,c)=>{if(x<0||y<0||x>=ow||y>=oh)return;const j=(y*ow+x)*4;o.data[j]=c[0];o.data[j+1]=c[1];o.data[j+2]=c[2];};
  for(const n of r.nodes){const c=COL[n.shape]||[120,120,120],x=(n.box[0]*OS)|0,y=(n.box[1]*OS)|0,bw=(n.box[2]*OS)|0,bh=(n.box[3]*OS)|0;for(let tk=0;tk<2;tk++){for(let xx=x;xx<=x+bw;xx++){set(xx,y+tk,c);set(xx,y+bh-tk,c);}for(let yy=y;yy<=y+bh;yy++){set(x+tk,yy,c);set(x+bw-tk,yy,c);}}}
  fs.writeFileSync(`eye/shots/${name}-perceived.png`, PNG.sync.write(o));
}
