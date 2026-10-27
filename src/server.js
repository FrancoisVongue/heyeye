// Глаз для X11: HTTP на 127.0.0.1:9223 поверх native/x11eye (кадр из общей памяти X, ввод через XTEST,
// изменения экрана через DAMAGE). Никакого браузерного протокола и DOM — только пиксели и системный ввод.
//
//   /look[?fast=1&depth=N&png=1]   разобрать экран → дерево узлов с id (png=1 — сохранить разметку в shots/look.png)
//   /read?id=N[&scale=1.5]         прочитать текст в узле (или весь экран без id)
//   /detail?id=N[&scale=2]         разобрать узел вблизи (увеличенно) → мелкие под-элементы, получают новые id
//   /select?id=N&q=фраза           выделить фразу мышью (координаты слов из чтения текста)
//   /act?action=...                move|click|dblclick|rightclick|middleclick|drag|pan|scroll|type|key|hotkey
//                                  точка: id=N | box=x,y,w,h | x=..&y=..; цель drag: toid= | tobox= | tox=&toy=
//                                  после действия ждём, пока экран успокоится, и сообщаем, что изменилось
//   /changes[?quiet=150&first=400&timeout=3000]   что перерисовалось с последнего /look или /act
//   /wins                          окна: положение, размер, заголовок
//   /shot[?name=...]  /raw?id=N    сохранить экран или узел в PNG (для человека)
//
//   DISPLAY=:99 node src/server.js
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { X11 } from "./x11.js";
import { perceive, treeText } from "./perceive.js";
import { readRegion, cropScale, warmup } from "./ocr.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = path.join(ROOT, "shots");
const PORT = parseInt(process.env.EYE_PORT || "9223", 10);

const x = new X11();
const { W, H } = await x.info();
warmup().catch((e) => console.error("[eye] модель чтения текста не загрузилась:", e.message));

let last = { nodes: [], W, H };   // последний разбор: узлы с id → координаты для действий

const T = (res, code, s) => { res.writeHead(code, { "content-type": "text/plain; charset=utf-8" }); res.end(s); };
const J = (res, code, o) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(o)); };
const norm = (s) => (s || "").toLowerCase().replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/\s+/g, " ").trim();
const nodeById = (id) => last.nodes.find((n) => String(n.id) === String(id));
// русские буквы, которые выглядят как латинские, → латиница (только для сравнения строк)
const LOOK = { а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", і: "i" };
const fold = (s) => s.replace(/[авеёкмнорстухі]/g, (c) => LOOK[c]);
const inter = (a, b) => Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));

// точка: центр узла по id, центр бокса "x,y,w,h" или явные x,y
function pt(p, key = "") {
  const id = p.get(key + "id");
  if (id != null) { const n = nodeById(id); if (!n) throw new Error(`нет узла id=${id} (сделай /look)`); return { x: n.box[0] + n.box[2] / 2, y: n.box[1] + n.box[3] / 2 }; }
  const box = (p.get(key + "box") || "").split(",").map(Number);
  if (box.length >= 2 && !Number.isNaN(box[0])) return { x: box[0] + (box[2] || 0) / 2, y: box[1] + (box[3] || 0) / 2 };
  const px = p.get(key + "x"), py = p.get(key + "y");
  if (px == null || py == null) return null;
  return { x: +px, y: +py };
}
const need = (q) => { if (!q) throw new Error("нужна точка: id= | box= | x=&y="); return q; };

// область: узел по id, явный box=x,y,w,h, иначе весь экран. label — как назвать её в ответе.
function region(p) {
  const id = p.get("id");
  if (id != null) { const n = nodeById(id); if (!n) throw new Error(`нет узла id=${id} (сделай /look)`); return { box: n.box, label: `узел ${id}` }; }
  const b = (p.get("box") || "").split(",").map(Number);
  if (b.length === 4 && b.every((v) => !Number.isNaN(v))) return { box: b, label: `область @${b[0]},${b[1]} ${b[2]}×${b[3]}` };
  return { box: [0, 0, W, H], label: "весь экран" };
}

// что изменилось → текст: где и какие узлы последнего разбора задело
function describe(ch) {
  if (!ch.rects.length) return `на экране ничего не изменилось (ждал ${ch.waited} мс${ch.redrawn ? ", перерисовка была, но пиксели те же" : ""})`;
  const area = ch.rects.reduce((s, r) => s + r[2] * r[3], 0), frac = area / (W * H);
  const hit = new Set();
  for (const r of ch.rects) for (const n of last.nodes) if (inter(r, n.box) > 0.3 * Math.min(n.box[2] * n.box[3], r[2] * r[3])) hit.add(n.id);
  const where = ch.rects.slice(0, 6).map((r) => `@${r[0]},${r[1]} ${r[2]}×${r[3]}`).join(" ") + (ch.rects.length > 6 ? ` …ещё ${ch.rects.length - 6}` : "");
  return `изменилось ${ch.rects.length} мест (${(frac * 100).toFixed(frac < 0.01 ? 1 : 0)}% экрана): ${where}` +
    (hit.size ? ` · задеты узлы [${[...hit].slice(0, 12).join(",")}${hit.size > 12 ? ",…" : ""}]` : "") +
    (frac > 0.5 ? " · экран почти целиком другой — сделай /look" : "") +
    (ch.settled ? `` : ` · экран ещё меняется (ждал ${ch.waited} мс)`);
}

// имена клавиш в стиле браузера → имена X11
const keyName = (k) => {
  const m = { Control: "ctrl", Meta: "super", Command: "super", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", " ": "space" };
  return m[k] || k;
};

const COL = { button: [245, 158, 11], text: [14, 165, 183], block: [8, 145, 178], bar: [255, 90, 0], image: [230, 20, 200], rect: [22, 163, 74], "round-rect": [47, 107, 255], circle: [225, 29, 72], icon: [255, 140, 0] };
function savePng(f, file, nodes = []) {
  const png = new PNG({ width: f.W, height: f.H }); png.data = Buffer.from(f.data.buffer, f.data.byteOffset, f.data.length);
  if (nodes.length) {
    png.data = Buffer.from(png.data);   // разметку рисуем на копии
    const d = png.data, set = (px, py, c) => { if (px < 0 || py < 0 || px >= f.W || py >= f.H) return; const i = (py * f.W + px) * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; };
    for (const n of nodes) { const c = COL[n.shape] || [164, 75, 255], [bx, by, bw, bh] = n.box.map(Math.round); for (let t = 0; t < 2; t++) { for (let i = bx; i <= bx + bw; i++) { set(i, by + t, c); set(i, by + bh - t, c); } for (let j = by; j <= by + bh; j++) { set(bx + t, j, c); set(bx + bw - t, j, c); } } }
  }
  fs.mkdirSync(SHOTS, { recursive: true });
  const fp = path.join(SHOTS, file);
  fs.writeFileSync(fp, PNG.sync.write(png));
  return fp;
}

async function handle(req, res) {
  const url = new URL(req.url, "http://x"), p = url.searchParams, route = url.pathname;

  if (route === "/health") return J(res, 200, { ok: true, W, H });
  if (route === "/wins") return T(res, 200, (await x.wins()).map((w) => `${w.name || "(без имени)"} @${w.box[0]},${w.box[1]} ${w.box[2]}×${w.box[3]}`).join("\n"));

  if (route === "/look") {
    await x.reset();                                   // /changes теперь будет отвечать «что изменилось после этого взгляда»
    const t0 = performance.now();
    const f = await x.frame();
    const r = await perceive(f, Object.fromEntries(p));
    last = { nodes: r.nodes, W: r.W, H: r.H };
    const ms = Math.round(performance.now() - t0);
    const maxD = p.get("depth") != null ? +p.get("depth") : 99;
    const shown = r.nodes.filter((n) => n.depth <= maxD);
    if (p.get("png") === "1") savePng(f, "look.png", shown);
    return T(res, 200, `ЭКРАН ${r.W}×${r.H} · ${shown.length}/${r.nodes.length} узлов (depth≤${maxD}, ${r.mode}, ${ms} мс)\n` + treeText(r.nodes, 1, maxD));
  }

  if (route === "/read") {
    const { box, label } = region(p);
    const f = await x.frame(box);                      // снимаем только эту область
    const { lines, words } = await readRegion(f, [0, 0, f.W, f.H], { scale: +(p.get("scale") || 1.5) });
    const sh = (b) => [b[0] + Math.max(0, box[0] | 0), b[1] + Math.max(0, box[1] | 0), b[2], b[3]];
    lines.forEach((l) => (l.box = sh(l.box))); words.forEach((w) => (w.box = sh(w.box)));
    if (p.get("json") != null) return J(res, 200, { box, lines, words });
    return T(res, 200, `${label}: ${lines.length} строк, ${words.length} слов\n` + lines.map((l) => `  @${l.box[0]},${l.box[1]} "${l.text}"`).join("\n"));
  }

  if (route === "/detail") {
    const { box, label } = region(p);
    const scale = +(p.get("scale") || 2);
    const f = await x.frame(box);
    const { frame: big, back } = cropScale(f, [0, 0, f.W, f.H], scale);
    const r = await perceive(big, Object.fromEntries(p));
    const ox = Math.max(0, box[0] | 0), oy = Math.max(0, box[1] | 0);
    const nodes = r.nodes.map((n, i) => { const b = back(n.box); return { ...n, id: i, box: [b[0] + ox, b[1] + oy, b[2], b[3]] }; });
    last = { nodes, W, H };                            // дальше /act?id= указывает на детали этого узла
    const maxD = p.get("depth") != null ? +p.get("depth") : 99;
    return T(res, 200, `${label} вблизи (×${scale}): ${nodes.length} под-элементов\n` + treeText(nodes, 1, maxD));
  }

  if (route === "/select") {
    const q = norm(p.get("q")), { box, label } = region(p);
    if (!q) return T(res, 400, "нужен &q=фраза");
    const f = await x.frame();
    const { words } = await readRegion(f, box, { scale: +(p.get("scale") || 1.5) });
    // чтение отдаёт куски-строки, а не слова → ищем фразу ВНУТРИ куска по символам и берём положение
    // пропорционально номеру символа. Похожие русские и латинские буквы приравниваем (модель их путает).
    const fq = fold(q);
    let hit = null;
    for (const w of words) {
      const t = fold(norm(w.text)), i = t.indexOf(fq);
      if (i >= 0) { hit = { w, x0: w.box[0] + (w.box[2] * i) / t.length, x1: w.box[0] + (w.box[2] * (i + fq.length)) / t.length }; break; }
    }
    if (!hit) return T(res, 404, `фраза не найдена (${label}). текст там: ${words.slice(0, 12).map((w) => w.text).join(" | ")}`);
    const y = hit.w.box[1] + hit.w.box[3] / 2;
    await x.reset();
    await x.drag(hit.x0, y, hit.x1, y, 20);
    return T(res, 200, `выделил мышью @${hit.x0 | 0},${y | 0}→${hit.x1 | 0},${y | 0} в строке "${hit.w.text}" · ` + describe(await x.changes()));
  }

  if (route === "/act") {
    const a = p.get("action") || "click";
    const wait = { quiet: +(p.get("quiet") || 150), first: +(p.get("first") || 400), timeout: +(p.get("timeout") || 3000) };
    await x.reset();
    let at = "";
    if (a === "move") { const q = need(pt(p)); await x.move(q.x, q.y); at = `@${q.x | 0},${q.y | 0}`; }
    else if (a === "click" || a === "dblclick" || a === "rightclick" || a === "middleclick") {
      const q = need(pt(p));
      await x.click(q.x, q.y, { button: a === "rightclick" ? 3 : a === "middleclick" ? 2 : 1, count: a === "dblclick" ? 2 : 1 });
      at = `@${q.x | 0},${q.y | 0}`;
    }
    else if (a === "drag" || a === "pan") {
      const A = need(pt(p)), B = pt(p, "to"); if (!B) return T(res, 400, "нужна цель: toid= | tobox= | tox=&toy=");
      const mods = (p.get("hold") || "").split(",").map((s) => s.trim()).filter(Boolean).map(keyName);
      for (const m of mods) await x.key(m, "down");
      await x.drag(A.x, A.y, B.x, B.y, +(p.get("steps") || 16));
      for (const m of mods.reverse()) await x.key(m, "up");
      at = `@${A.x | 0},${A.y | 0}→${B.x | 0},${B.y | 0}`;
    }
    else if (a === "scroll") {
      const q = pt(p); if (q) await x.move(q.x, q.y);
      await x.wheel(+(p.get("dx") || 0), +(p.get("dy") || 3));   // в щелчках колеса; dy>0 — вниз
      at = q ? `@${q.x | 0},${q.y | 0}` : "";
    }
    else if (a === "type") {
      const q = pt(p); if (q) { await x.click(q.x, q.y); await new Promise((r) => setTimeout(r, 60)); }
      await x.type(p.get("text") || "");
    }
    else if (a === "key") await x.key(keyName(p.get("key") || "Return"));
    // разделитель — запятая, плюс или пробел («+» в адресе запроса приходит пробелом)
    else if (a === "hotkey") await x.key((p.get("keys") || "").split(/[,+\s]+/).map((s) => keyName(s.trim())).filter(Boolean).join("+"));
    else return T(res, 400, "неизвестное action: " + a);
    return T(res, 200, `ok: ${a}${at ? " " + at : ""} · ` + describe(await x.changes(wait)));
  }

  if (route === "/changes") {
    const ch = await x.changes({ quiet: +(p.get("quiet") || 150), first: +(p.get("first") || 400), timeout: +(p.get("timeout") || 3000) });
    return p.get("json") != null ? J(res, 200, ch) : T(res, 200, describe(ch));
  }

  if (route === "/shot") return J(res, 200, { saved: savePng(await x.frame(), (p.get("name") || "shot").replace(/[^\w-]/g, "") + ".png") });
  if (route === "/raw") {
    const { box } = region(p);
    return J(res, 200, { saved: savePng(await x.frame(box), `raw-${p.get("id") ?? "region"}.png`), box });
  }

  return T(res, 404, "ГЛАЗА: /look /read?id= /detail?id= /changes /wins  РУКИ: /act?action= /select?id=&q=  ещё: /shot /raw?id=");
}

http.createServer((req, res) => handle(req, res).catch((e) => T(res, 500, "ошибка: " + (e.message || e))))
  .listen(PORT, "127.0.0.1", () => console.log(`[eye] X11 ${process.env.DISPLAY || ":99"} ${W}×${H} → http://127.0.0.1:${PORT}`));

process.on("SIGINT", () => { x.close(); process.exit(0); });
process.on("SIGTERM", () => { x.close(); process.exit(0); });
