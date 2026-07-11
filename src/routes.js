// Глаз — ЧИСТОЕ ЗРЕНИЕ. Никакого DOM/ML-детекторов. Только пиксели скриншота + мышь/клавиатура.
// Восприятие: islands.js (капля: контейнеры-острова) + ocr.js (текст с координатами).
// Транспорт сейчас — CDP (браузер = источник пикселей); в ОС-версии станет screencapture + nut.js,
// а контракт (/look /read /select /act) не изменится.
//
//   /look                    — разбить экран на регионы-острова (дерево id), нарисовать на стекле
//   /read?id=N               — фовеальный OCR внутри региона: текст + координаты слов
//   /select?id=N&q=фраза     — выделить произвольный текст мышью (координаты из OCR, без DOM)
//   /act?action=...          — руки: move|click|dblclick|rightclick|drag|pan|scroll|type|key|hotkey
//   /open?to=complex  /shot  /glass/clear
import fs from "node:fs";
import path from "node:path";
const fresh = (m) => import(`${m}?t=${Date.now()}`); // islands.js/ocr.js хот-релоадим; воркер OCR живёт в globalThis

const J = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
const T = (res, code, s) => { res.writeHead(code, { "content-type": "text/plain; charset=utf-8" }); res.end(s); };
const ATOMS = "eye/shots/atoms.json";
const loadAtoms = () => JSON.parse(fs.readFileSync(ATOMS, "utf8"));
const nodeById = (a, id) => a.nodes.find((n) => String(n.id) === String(id));
const norm = (s) => (s || "").toLowerCase().replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/\s+/g, " ").trim();

// точка для мыши: по id региона (центр), по box "x,y,w,h", или явные x,y (всё в CSS-пикселях)
function pt(p, key = "") {
  const id = p.get(key + "id");
  if (id) { try { const a = loadAtoms(), n = nodeById(a, id); if (n) return { x: Math.round((n.box[0] + n.box[2] / 2) / a.dpr), y: Math.round((n.box[1] + n.box[3] / 2) / a.dpr) }; } catch {} }
  const box = (p.get(key + "box") || "").split(",").map(Number);
  if (box.length >= 2 && !Number.isNaN(box[0])) return { x: box[0] + (box[2] || 2) / 2, y: box[1] + (box[3] || 2) / 2 };
  return { x: +p.get(key + "x"), y: +p.get(key + "y") };
}

// islands → сохранить atoms.json (боксы в ПИКСЕЛЯХ скриншота = device px, + dpr для перевода в CSS)
const clearGlass = (pg) => pg.evaluate(() => { document.getElementById("__eye_glass")?.remove(); document.getElementById("__eye_ov")?.remove(); document.querySelectorAll(".__eye_ov").forEach((e) => e.remove()); });

async function detectStore(page, p) {
  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
  await clearGlass(page);                     // убрать НАШУ разметку до съёмки (иначе OCR прочитает свои подписи!)
  const buf = await page.screenshot({ type: "png" });
  const r = await perceive(buf, p);           // капля + XY-бэкап если жидко
  fs.mkdirSync("eye/shots", { recursive: true });
  fs.writeFileSync(ATOMS, JSON.stringify({ dpr, W: r.W, H: r.H, nodes: r.nodes }));
  return { dpr, buf, r };
}

// нарисовать боксы на «стекле» (дебаг для человека — модель этого не видит)
async function drawGlass(page, boxes) {
  await page.evaluate((bx) => {
    document.getElementById("__eye_glass")?.remove();
    const g = document.createElement("div"); g.id = "__eye_glass";
    g.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;font:10px/1 ui-monospace,monospace";
    for (const b of bx) {
      const d = document.createElement("div");
      d.style.cssText = `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;border:2px ${b.dash ? "dashed" : "solid"} ${b.c};box-sizing:border-box`;
      const s = document.createElement("span"); s.textContent = b.t;
      s.style.cssText = `position:absolute;left:-1px;top:-11px;background:${b.c};color:#fff;padding:0 3px;border-radius:2px;white-space:nowrap`;
      d.appendChild(s); g.appendChild(d);
    }
    document.documentElement.appendChild(g);
  }, boxes);
}
const COL = { button: "#f59e0b", text: "#0ea5b7", block: "#0891b2", bar: "#ff5a00", image: "#e614c8", surface: "#f0a014", rect: "#16a34a", "round-rect": "#2f6bff", circle: "#e11d48", blob: "#a44bff" };
const ovl = (a, b) => { const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]), x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]); const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0); return i / (Math.min(a[2] * a[3], b[2] * b[3]) + 1e-9); };

// Вывод для ИИ: дерево в ПОРЯДКЕ ЧТЕНИЯ (сверху↓, слева→) с ПРЕВЬЮ текста (первые ~8 слов).
// Всё вложено под своим контейнером; верхний уровень = прямо под ЭКРАНОМ (ничего не висит бесхозным).
function treeText(nodes, dpr, maxD = 99) {
  const S = (v) => Math.round(v / dpr), inSet = new Set(nodes.filter((n) => n.depth <= maxD).map((n) => n.id));
  const kids = new Map(), roots = [];
  for (const n of nodes) { if (n.depth > maxD) continue; if (n.parent >= 0 && inSet.has(n.parent)) (kids.get(n.parent) || kids.set(n.parent, []).get(n.parent)).push(n); else roots.push(n); }
  const ro = (arr) => arr.slice().sort((a, b) => (a.box[1] - b.box[1]) || (a.box[0] - b.box[0])); // порядок чтения
  const prev = (t) => { if (!t) return ""; const ws = t.trim().split(/\s+/); return ` "${ws.slice(0, 8).join(" ")}${ws.length > 8 ? "…" : ""}"`; };
  const out = [];
  const walk = (n, d) => { out.push(`${"  ".repeat(d)}[${n.id}] ${n.shape} @${S(n.box[0])},${S(n.box[1])} ${S(n.box[2])}×${S(n.box[3])}${prev(n.text)}`); ro(kids.get(n.id) || []).forEach((c) => walk(c, d + 1)); };
  ro(roots).forEach((n) => walk(n, 0));
  return out.join("\n");
}

// ОБЩИЙ АЛГОРИТМ: КАПЛЯ (картинки + цветные контейнеры) + ТЕКСТ (блоки по размеру, Apple Vision).
// XY-cut — только тихий последний ФОЛБЭК, если текста почти нет (текст отрисован картинкой).
export async function perceive(buf, p) {
  const [I, TG] = await Promise.all([fresh("./islands.js"), fresh("./textgroup.js")]);
  const frame = I.decodeFrame(buf);            // PNG декодируем ОДИН раз → сырой RGBA, дальше все стадии берут его
  // OCR (Vision, ~430мс) запускаем СРАЗУ и АСИНХРОННО — он в отдельном процессе (Neural Engine), пока
  // главный поток считает CV (капля/грань/панели). Забираем результат позже → OCR прячется ПОД CV.
  const ocrP = p.get("text") !== "0" ? TG.textBlocks(buf).catch(() => ({ blocks: [] })) : Promise.resolve({ blocks: [] });
  const r = I.detect(frame, { tol: +(p.get("tol") || 12), maxDepth: +(p.get("maxDepth") || 3) });
  const images = r.nodes.filter((n) => n.image);
  const regions = r.nodes.filter((n) => !n.image && n.shape !== "surface" && n.depth <= 1 && n.box[2] * n.box[3] > 0.004 * r.W * r.H);
  // грань-карточки и боковые панели зависят ТОЛЬКО от кадра → считаем их тоже ДО ожидания OCR (под OCR)
  const canvasy = regions.length <= 2 && images.length === 0;
  let erRects = [], spPanels = [];
  try { erRects = I.edgeRects(frame, canvasy ? { perimMin: 0.4, emptyMin: 0.1 } : {}).rects; spPanels = I.sidePanels(frame).panels; } catch (e) {}
  const tg = await ocrP;                        // забираем OCR (крутился параллельно — уже почти готов)
  // текст ВНУТРИ картинки (OCR-мусор на фото) выкидываем ДО solidify, чтобы он не стал ложной «кнопкой»
  let blocks = tg.blocks.filter((b) => !images.some((im) => ovl(b.box, im.box) > 0.55));
  try { const B = await fresh("./buttons.js"); blocks = B.solidify(frame, blocks); } catch (e) {}
  const nodes = []; let id = 0;
  for (const im of images) nodes.push({ id: id++, parent: -1, shape: "image", image: true, depth: 0, box: im.box });
  for (const c of regions) nodes.push({ id: id++, parent: -1, shape: c.shape, image: false, depth: 0, box: c.box });
  for (const b of blocks) nodes.push({ id: id++, parent: -1, shape: b.shape === "button" ? "button" : "text", image: false, depth: 0, box: b.box, text: b.text });
  // ГИБРИД зернистости: блок-ряд/колонка остаётся для ЧТЕНИЯ, а его под-элементы (каждый чип, канал,
  // пункт меню) эмитим ОТДЕЛЬНЫМИ text-узлами → вложенность ниже делает их детьми блока, ИИ может
  // кликнуть конкретный по id. Текст внутри картинки пропускаем. Дубля нет: дети строго меньше блока.
  const iouB = (a, b) => { const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]), x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]); const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0); return i / (a[2] * a[3] + b[2] * b[3] - i + 1e-9); };
  for (const wd of (tg.words || [])) {                                   // сырые OCR-сегменты = каждый чип/канал/строка
    if (images.some((im) => ovl(wd.box, im.box) > 0.55)) continue;        // текст на картинке — пропуск
    if (nodes.some((n) => n.text && iouB(n.box, wd.box) > 0.8)) continue; // сегмент САМ уже стал блоком → не дубль
    nodes.push({ id: id++, parent: -1, shape: "text", image: false, depth: 0, box: wd.box, text: wd.text });
  }
  let mode = "regions+text";
  if (blocks.length < 4 && regions.length < 3) {                        // текста нет (нарисован картинкой) → XY-фолбэк
    const X = await fresh("./xycut.js"); const xr = X.cut(buf, { gapFrac: 0.011 });
    for (const bx of xr.blocks) if (!nodes.some((n) => ovl(bx, n.box) > 0.5)) nodes.push({ id: id++, parent: -1, shape: "block", image: false, depth: 0, box: bx });
    mode = "regions+xy(fallback)";
  }
  // ГРАНЬ-КАРТОЧКИ (карманы цвета холста) + БОКОВЫЕ ПАНЕЛИ уже посчитаны ВЫШЕ (под OCR). Добавляем
  // ТОЛЬКО новые: дубль = ТОТ ЖЕ бокс (IoU), а не «содержит мелкий текст» (иначе карточка выкинулась бы
  // из-за своей же подписи). На обычных сайтах карточки уже пойманы по цвету → тут IoU-дубль → пропуск.
  try {
    const iou = (a, b) => { const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]), x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]); const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0); return i / (a[2] * a[3] + b[2] * b[3] - i + 1e-9); };
    for (const c of erRects.concat(spPanels)) {
      if (c.box[2] * c.box[3] > 0.6 * r.W * r.H) continue;                // не вся страница/большой фон
      if (nodes.some((n) => iou(c.box, n.box) > 0.55)) continue;          // уже есть (тот же контейнер по цвету)
      nodes.push({ id: id++, parent: -1, shape: "rect", image: false, depth: 0, box: c.box });
    }
  } catch (e) {}
  // ВЛОЖЕННОСТЬ: parent = НАИМЕНЬШИЙ узел, содержащий этот; depth = длина цепочки родителей.
  const A = (x) => x[2] * x[3], has = (P, c) => P.box[0] <= c.box[0] + 3 && P.box[1] <= c.box[1] + 3 && P.box[0] + P.box[2] >= c.box[0] + c.box[2] - 3 && P.box[1] + P.box[3] >= c.box[1] + c.box[3] - 3 && A(P.box) > A(c.box) * 1.05;
  for (const n of nodes) { let best = -1, ba = Infinity; for (const m of nodes) if (m.id !== n.id && has(m, n)) { const a = A(m.box); if (a < ba) { ba = a; best = m.id; } } n.parent = best; }
  // БАРЫ: тонкие БЕСХОЗНЫЕ узлы, выстроенные в горизонтальный РЯД (топ-бар/тулбар/футер) → бар-контейнер,
  // чтобы ничего не висело на фоне без родителя. Карточки (высокие) не трогаем — только тонкие ряды.
  const thin = nodes.filter((n) => n.parent < 0 && n.box[3] < 0.06 * r.H && !n.image);
  const vov = (a, b) => { const t = Math.max(a.box[1], b.box[1]), bo = Math.min(a.box[1] + a.box[3], b.box[1] + b.box[3]); return Math.max(0, bo - t) / Math.max(1, Math.min(a.box[3], b.box[3])); };
  const tp = thin.map((_, i) => i), tf = (x) => { while (tp[x] !== x) x = tp[x] = tp[tp[x]]; return x; };
  for (let i = 0; i < thin.length; i++) for (let j = i + 1; j < thin.length; j++) if (vov(thin[i], thin[j]) > 0.4) tp[tf(i)] = tf(j);
  const rowM = new Map(); thin.forEach((n, i) => { const g = tf(i); (rowM.get(g) || rowM.set(g, []).get(g)).push(n); });
  const bars = [];
  for (const g of rowM.values()) {
    if (g.length < 2) continue;
    let x0 = Math.min(...g.map((n) => n.box[0])), y0 = Math.min(...g.map((n) => n.box[1])), x1 = Math.max(...g.map((n) => n.box[0] + n.box[2])), y1 = Math.max(...g.map((n) => n.box[1] + n.box[3]));
    if (x1 - x0 < 0.4 * r.W) continue;                                  // ряд должен быть ШИРОКИМ (это бар, а не пара кнопок)
    if (y0 < 0.08 * r.H) { x0 = 0; y0 = 0; x1 = r.W; }                  // ТОП-бар (хедер) — во всю ширину от самого верха
    else if (y1 > 0.92 * r.H) { x0 = 0; x1 = r.W; y1 = r.H; }           // футер — во всю ширину до низа
    else continue;                                                     // ряд В СЕРЕДИНЕ страницы — это НЕ бар (напр. карточки на канвасе Piano, случайно на одной высоте) — не оборачиваем
    const bar = { id: id++, parent: -1, shape: "bar", image: false, box: [x0, y0, x1 - x0, y1 - y0] };
    nodes.push(bar); bars.push(bar); for (const n of g) n.parent = bar.id;
  }
  // ФОВЕАЛЬНАЯ ДЕТАЛИЗАЦИЯ (general, НЕ только бары): глобальный проход даунскейлит страницу и ТЕРЯЕТ
  // мелкие иконки/кнопки (тонкие структуры исчезают при сжатии). Поэтому КАЖДЫЙ крупный контейнер
  // верхнего уровня перепроверяем в НАТИВНОМ разрешении и добираем мелкие компактные элементы,
  // которых там ещё нет. Работает на любом контейнере любого сайта (сайдбар, карточка, тулбар…).
  const PAGE = r.W * r.H;
  // каждый КРУПНЫЙ контейнер (>3% страницы, но не вся) детализируем ВНУТРИ в НАТИВНОМ разрешении.
  // minArea теперь ОТНОСИТЕЛЬНО КОНТЕЙНЕРА (крутим islands на кропе) → иконка мелкая на странице,
  // но нормальная в своём контейнере → проходит и добавляется. Ровно то правило.
  const conts = nodes.filter((n) => !n.image && n.shape !== "surface" && n.shape !== "text" && n.shape !== "button" && A(n.box) > 0.03 * PAGE && A(n.box) < 0.7 * PAGE).sort((a, b) => A(a.box) - A(b.box)).slice(0, 20);
  for (const cont of conts) {
    try {
      const [cx, cy, cw, ch] = cont.box;
      const crop = I.cropFrame(frame, cx, cy, cw, ch);           // СРЕЗ сырых пикселей (без декода/энкода PNG)
      const sub = I.detect(crop, { tol: 12, maxDepth: 1, minAreaFrac: 0.006, maxW: Math.min(2600, cw) });
      const back = (b) => [b[0] + cx, b[1] + cy, b[2], b[3]];    // detect на нативном кропе → просто сдвиг координат
      for (const s of sub.nodes) {
        if (s.shape === "surface") continue;
        const b = back(s.box);
        if (b[2] < 6 || b[3] < 6 || A(b) > 0.4 * A(cont.box)) continue;             // не шум и не сам контейнер
        if (nodes.some((n) => n.id !== cont.id && ovl(b, n.box) > 0.4)) continue;    // уже найдено — не дублируем
        nodes.push({ id: id++, parent: cont.id, shape: s.shape, image: !!s.image, box: b });
      }
    } catch (e) {}
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) { let d = 0, p = n.parent, k = 0; while (p >= 0 && k++ < 40) { d++; p = byId.get(p)?.parent ?? -1; } n.depth = d; }
  return { W: r.W, H: r.H, nodes, mode };
}

export async function handle({ req, res, browser, pickPage }) {
  const url = new URL(req.url, "http://x");
  const p = url.searchParams;
  const path_ = url.pathname;

  if (path_ === "/health") return J(res, 200, { ok: true });
  if (path_ === "/pages") return J(res, 200, { pages: (await browser.pages()).map((x) => x.url()) });

  const page = await pickPage(p.get("url") || undefined);
  const M = page.mouse, K = page.keyboard;

  // ---------- открыть нашу тестовую страницу в НОВОЙ вкладке (Piano и пр. не трогаем) ----------
  if (path_ === "/open") {
    const name = p.get("to") || "complex", fp = "file://" + path.resolve("eye/page/" + name + ".html");
    const olds = (await browser.pages()).filter((x) => x.url().includes("/" + name + ".html")); // закрыть старые той же страницы
    let pg = olds[0] || await browser.newPage();
    for (const extra of olds.slice(1)) { try { await extra.close(); } catch {} }
    await pg.goto(fp + "?t=" + Date.now(), { waitUntil: "load" }); await pg.bringToFront(); // cache-bust + на передний план
    return T(res, 200, "открыл: " + fp);
  }
  if (path_ === "/shot") { fs.mkdirSync("eye/shots", { recursive: true }); const fp = "eye/shots/" + (p.get("name") || "shot") + ".png"; await page.screenshot({ path: fp }); return J(res, 200, { saved: fp }); }
  // открыть НОВУЮ вкладку на произвольном URL (для тестов; существующие вкладки не трогаем)
  if (path_ === "/goto") { const u = p.get("to"); const pg = await browser.newPage(); try { await pg.goto(u, { waitUntil: "load", timeout: 30000 }); } catch {} await pg.bringToFront(); await new Promise((r) => setTimeout(r, 1200)); return T(res, 200, "открыл: " + pg.url()); }

  // ---------- СНИМОК ЛЮБОГО САЙТА → статичная страница-скриншот + разметка поверх ----------
  // Снимаем текущую вкладку, делаем HTML где ВЕСЬ контент = этот скриншот (data-URI), рисуем боксы.
  // Дальше /look /read /select работают на этом снимке (это буквально тот же скриншот, но статичный).
  if (path_ === "/snap") {
    const src = await pickPage(p.get("from") || undefined);
    const dpr = await src.evaluate(() => window.devicePixelRatio || 1);
    await clearGlass(src);                     // убрать разметку до съёмки, чтобы OCR не читал свои подписи
    const buf = await src.screenshot({ type: "png", fullPage: p.get("full") != null });
    const r = await perceive(buf, p);           // капля + XY-бэкап если жидко
    const cssW = Math.round(r.W / dpr), cssH = Math.round(r.H / dpr);
    const nm = (p.get("name") || "snap").replace(/[^a-z0-9-]/gi, ""); // именованная страница на сайт
    const file = nm === "snap" ? "snap.html" : `snap-${nm}.html`;
    const html = `<!doctype html><meta charset="utf-8"><title>${nm}</title><style>html,body{margin:0}img{display:block;width:${cssW}px;height:${cssH}px}</style><img src="data:image/png;base64,${buf.toString("base64")}">`;
    fs.mkdirSync("eye/page", { recursive: true });
    fs.writeFileSync("eye/page/" + file, html);
    const snapUrl = "file://" + path.resolve("eye/page/" + file);
    const snaps = (await browser.pages()).filter((x) => x.url().includes("/" + file));
    let pg = snaps[0] || await browser.newPage();
    for (const extra of snaps.slice(1)) { try { await extra.close(); } catch {} } // закрыть дубли этой snap-вкладки
    await pg.goto(snapUrl + "?t=" + Date.now(), { waitUntil: "load" }); // cache-bust
    fs.mkdirSync("eye/shots", { recursive: true });
    fs.writeFileSync(ATOMS, JSON.stringify({ dpr, W: r.W, H: r.H, nodes: r.nodes }));
    const maxD = p.get("depth") != null ? +p.get("depth") : 99;
    const shown = r.nodes.filter((n) => n.depth <= maxD);
    await drawGlass(pg, shown.map((n) => ({ x: Math.round(n.box[0] / dpr), y: Math.round(n.box[1] / dpr), w: Math.round(n.box[2] / dpr), h: Math.round(n.box[3] / dpr), c: COL[n.shape] || "#a44bff", t: `${n.id} ${n.shape}`, dash: n.shape === "surface" })));
    return T(res, 200, `снял ${r.W}×${r.H}px → ${file} · ${shown.length}/${r.nodes.length} регионов (depth≤${maxD}, ${r.mode})`);
  }
  if (path_ === "/glass/clear") { await page.evaluate(() => document.getElementById("__eye_glass")?.remove()); return T(res, 200, "стекло убрано"); }

  // ---------- ГЛАЗА: разбить экран на регионы-острова (капля) → дерево id + стекло ----------
  if (path_ === "/look") {
    const { dpr, r } = await detectStore(page, p);
    const maxD = p.get("depth") != null ? +p.get("depth") : 99;
    const shown = r.nodes.filter((n) => n.depth <= maxD);
    await drawGlass(page, shown.map((n) => ({ x: Math.round(n.box[0] / dpr), y: Math.round(n.box[1] / dpr), w: Math.round(n.box[2] / dpr), h: Math.round(n.box[3] / dpr), c: COL[n.shape] || "#a44bff", t: `${n.id} ${n.shape}`, dash: n.shape === "surface" })));
    const S = (v) => Math.round(v / dpr);
    return T(res, 200, `ЭКРАН ${S(r.W)}×${S(r.H)} · ${shown.length}/${r.nodes.length} узлов (depth≤${maxD}, порядок чтения ↓→)\n` + treeText(r.nodes, dpr, maxD));
  }

  // ---------- ПЕРЕКРЫТИЕ: восстановить окна по краям (для наложенных прямоугольников) ----------
  if (path_ === "/rects") {
    const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
    await page.evaluate(() => document.getElementById("__eye_glass")?.remove());
    const buf = await page.screenshot({ type: "png" });
    const R = await fresh("./rects.js");
    const r = R.detectRects(buf, { T: +(p.get("T") || 18) });
    const pal = ["#e11d48", "#16a34a", "#2f6bff", "#f0a014", "#a44bff"];
    const boxes = r.rects.map((c, i) => ({ x: Math.round(c.box[0] / dpr), y: Math.round(c.box[1] / dpr), w: Math.round(c.box[2] / dpr), h: Math.round(c.box[3] / dpr), c: pal[i % 5], t: `окно ${i + 1}`, dash: false }));
    await drawGlass(page, boxes);
    return T(res, 200, `перекрытие: ${boxes.length} окон\n` + r.rects.map((c, i) => `[${i + 1}] @${c.box.map((v) => Math.round(v / dpr)).join(",")}`).join("\n"));
  }

  // ---------- ПЕРЕКРЫТИЕ. Два режима: rects (для ИИ: полные прямоугольники + перекрытая часть) | flood (дебаг заливки)
  if (path_ === "/overlap") {
    const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
    await page.evaluate(() => { document.getElementById("__eye_glass")?.remove(); document.getElementById("__eye_ov")?.remove(); document.querySelectorAll(".__eye_ov").forEach((e) => e.remove()); });
    const buf = await page.screenshot({ type: "png" });
    const O = await fresh("./overlap.js");
    const r = O.detectShapes(buf, { valleyM: +(p.get("m") || 5), edgeT: +(p.get("edge") || 20) });
    const cssW = Math.round(r.W / dpr), cssH = Math.round(r.H / dpr), D = (v) => Math.round(v / dpr);
    if (p.get("mode") === "flood") { // дебаг: сырые формы заливки как полупрозрачная картинка
      const uri = "data:image/png;base64," + Buffer.from(r.overlayPng).toString("base64");
      await page.evaluate(({ uri, cssW, cssH }) => { const im = document.createElement("img"); im.id = "__eye_ov"; im.src = uri; im.style.cssText = `position:fixed;left:0;top:0;width:${cssW}px;height:${cssH}px;z-index:2147483646;pointer-events:none`; document.documentElement.appendChild(im); }, { uri, cssW, cssH });
    } else { // для ИИ: ПОЛНЫЙ прямоугольник каждого окна (сплошной) + перекрытая часть (штриховка «не видно»)
      const rects = r.regions.map((g, i) => ({ x: D(g.box[0]), y: D(g.box[1]), w: D(g.box[2]), h: D(g.box[3]), c: g.color, t: `окно ${i + 1}${g.occBoxes.length ? " (перекрыто)" : ""}`, occ: g.occBoxes.map((b) => ({ x: D(b[0]), y: D(b[1]), w: D(b[2]), h: D(b[3]) })) }));
      await page.evaluate((rs) => {
        const g = document.createElement("div"); g.id = "__eye_ov"; g.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none;font:11px/1 ui-monospace,monospace";
        for (const b of rs) {
          const d = document.createElement("div"); d.style.cssText = `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;border:3px solid ${b.c};box-sizing:border-box`;
          const s = document.createElement("span"); s.textContent = b.t; s.style.cssText = `position:absolute;left:-1px;top:-13px;background:${b.c};color:#fff;padding:0 4px;border-radius:2px;white-space:nowrap`; d.appendChild(s); g.appendChild(d);
          for (const oc of b.occ) { const o = document.createElement("div"); o.textContent = "перекрыто"; o.style.cssText = `position:absolute;left:${oc.x}px;top:${oc.y}px;width:${oc.w}px;height:${oc.h}px;box-sizing:border-box;border:2px dashed #fff;color:#fff;font-size:10px;display:flex;align-items:center;justify-content:center;background:repeating-linear-gradient(45deg,#0008,#0008 6px,#0000 6px,#0000 12px)`; g.appendChild(o); }
        }
        document.documentElement.appendChild(g);
      }, rects);
    }
    const lines = r.regions.map((g, i) => `[окно ${i + 1}] полный @${g.box.map(D).join(",")} fill=${g.fill}` + (g.occBoxes.length ? ` · ПЕРЕКРЫТО: ${g.occBoxes.map((b) => "@" + b.map(D).join(",")).join(" ")}` : " · видно целиком (сверху)"));
    return T(res, 200, `перекрытие (${p.get("mode") === "flood" ? "заливка" : "прямоугольники"}): ${r.regions.length} окон\n` + lines.join("\n"));
  }
  if (path_ === "/overlap/clear") { await page.evaluate(() => { document.getElementById("__eye_ov")?.remove(); document.querySelectorAll(".__eye_ov").forEach((e) => e.remove()); }); return T(res, 200, "оверлей убран"); }

  // ---------- RAW: вырезать регион как СЫРЫЕ пиксели (без обработки), отдать файл ----------
  if (path_ === "/raw") {
    const a = loadAtoms(), box = p.get("id") ? nodeById(a, p.get("id"))?.box : [0, 0, a.W, a.H];
    if (!box) return T(res, 404, "нет региона id=" + p.get("id"));
    await clearGlass(page);
    const buf = await page.screenshot({ type: "png" });
    const OCR = await fresh("./vision.js");
    const { buf: crop } = OCR.cropScale(buf, box, +(p.get("scale") || 1)); // scale=1 = натуральный размер
    fs.mkdirSync("eye/shots", { recursive: true });
    const fp = "eye/shots/raw-" + (p.get("id") || "screen") + ".png"; fs.writeFileSync(fp, crop);
    return J(res, 200, { saved: fp, box, note: "сырой кроп региона (пиксели без обработки)" });
  }

  // ---------- DETAIL (depth=max): ФОВЕАЛЬНО перевоспринять регион вблизи (кроп+зум → мелкая детализация) ----------
  if (path_ === "/detail") {
    const a = loadAtoms(), n = p.get("id") ? nodeById(a, p.get("id")) : null;
    const box = n ? n.box : [0, 0, a.W, a.H];
    if (!box) return T(res, 404, "нет региона id=" + p.get("id"));
    await clearGlass(page);
    const buf = await page.screenshot({ type: "png" });
    const OCR = await fresh("./vision.js");
    const scale = +(p.get("scale") || 2.5);
    const { buf: crop, back } = OCR.cropScale(buf, box, scale);          // вырезаем регион и увеличиваем
    const r = await perceive(crop, p);                                   // перевосприятие вблизи → мелкие под-элементы
    const nodes = r.nodes.map((nd, i) => ({ ...nd, id: i, box: back(nd.box) })); // координаты назад в абсолютные
    fs.writeFileSync(ATOMS, JSON.stringify({ dpr: a.dpr, W: a.W, H: a.H, nodes })); // фокус: atoms = детали региона (для /act)
    const maxD = p.get("depth") != null ? +p.get("depth") : 99, shown = nodes.filter((x) => x.depth <= maxD);
    await drawGlass(page, shown.map((x) => ({ x: Math.round(x.box[0] / a.dpr), y: Math.round(x.box[1] / a.dpr), w: Math.round(x.box[2] / a.dpr), h: Math.round(x.box[3] / a.dpr), c: COL[x.shape] || "#a44bff", t: `${x.id} ${x.shape}`, dash: x.shape === "surface" })));
    const S = (v) => Math.round(v / a.dpr);
    const txt = shown.map((x) => `${"  ".repeat(x.depth)}[${x.id}] ${x.shape} @${S(x.box[0])},${S(x.box[1])} ${S(x.box[2])}×${S(x.box[3])}${x.text ? ` "${x.text.slice(0, 40)}"` : ""}`).join("\n");
    return T(res, 200, `детально регион ${p.get("id") ?? "весь экран"} (×${scale}): ${shown.length} под-элементов\n${txt}`);
  }

  // ---------- ГЛАЗА: фовеальный OCR ВНУТРИ региона → текст + координаты слов ----------
  if (path_ === "/read") {
    const a = loadAtoms(), buf = await page.screenshot({ type: "png" });
    const id = p.get("id");
    const box = id ? (nodeById(a, id)?.box) : [0, 0, a.W, a.H];
    if (!box) return T(res, 404, "нет региона id=" + id);
    const OCR = await fresh("./vision.js");
    const { lines, words } = await OCR.readRegion(buf, box, { scale: +(p.get("scale") || 2.5) });
    const S = (v) => Math.round(v / a.dpr);
    if (p.get("json") != null) return J(res, 200, { id, lines, words });
    const body = lines.map((l) => `  @${S(l.box[0])},${S(l.box[1])} "${l.text}"`).join("\n");
    return T(res, 200, `регион ${id ?? "весь экран"}: ${lines.length} строк, ${words.length} слов\n${body}`);
  }

  // ---------- РУКИ+ГЛАЗА: выделить произвольный ТЕКСТ мышью (координаты из OCR, без DOM) ----------
  if (path_ === "/select") {
    const a = loadAtoms(), buf = await page.screenshot({ type: "png" });
    const id = p.get("id"), q = norm(p.get("q"));
    const box = id ? (nodeById(a, id)?.box) : [0, 0, a.W, a.H];
    if (!box) return T(res, 404, "нет региона id=" + id);
    if (!q) return T(res, 400, "нужен &q=фраза");
    const OCR = await fresh("./vision.js");
    const { words } = await OCR.readRegion(buf, box, { scale: +(p.get("scale") || 2.5) });
    // ищем непрерывный ряд слов, чей склеенный текст совпадает с фразой
    const toks = q.split(" ");
    let run = null;
    for (let i = 0; i + toks.length <= words.length; i++) {
      if (toks.every((t, k) => norm(words[i + k].text) === t || norm(words[i + k].text).replace(/[.,:;!?]$/, "") === t)) { run = words.slice(i, i + toks.length); break; }
    }
    if (!run) return T(res, 404, `фраза не найдена OCR-ом в регионе. слова рядом: ${words.slice(0, 12).map((w) => w.text).join(" ")}`);
    const first = run[0].box, last = run[run.length - 1].box, dpr = a.dpr;
    const sx = first[0] / dpr, sy = (first[1] + first[3] / 2) / dpr;          // левый край первого слова
    const ex = (last[0] + last[2]) / dpr, ey = (last[1] + last[3] / 2) / dpr; // правый край последнего
    await M.move(sx, sy); await M.down(); await M.move(ex, ey, { steps: 24 }); await M.up();
    await new Promise((r) => setTimeout(r, 150));
    const sel = await page.evaluate(() => String(window.getSelection()));
    return T(res, 200, `выделил по OCR-координатам [${Math.round(sx)},${Math.round(sy)}→${Math.round(ex)},${Math.round(ey)}]\nвыделено: "${sel}"${sel ? "" : "  (пусто — координаты мимо или текст в canvas)"}`);
  }

  // ---------- РУКИ: человеческий ввод по координатам (или по id региона) ----------
  if (path_ === "/act") {
    const a = p.get("action") || "click";
    try {
      if (a === "move") { const { x, y } = pt(p); await M.move(x, y, { steps: 8 }); }
      else if (a === "click") { const { x, y } = pt(p); await M.click(x, y, { button: p.get("button") || "left" }); }
      else if (a === "dblclick") { const { x, y } = pt(p); await M.move(x, y); await M.down({ clickCount: 1 }); await M.up({ clickCount: 1 }); await M.down({ clickCount: 2 }); await M.up({ clickCount: 2 }); }
      else if (a === "rightclick") { const { x, y } = pt(p); await M.click(x, y, { button: "right" }); }
      else if (a === "drag" || a === "pan") {
        const A = pt(p), B = pt(p, "to"); const steps = +(p.get("steps") || 24);
        const mods = (p.get("hold") || "").split(",").map((s) => s.trim()).filter(Boolean);
        for (const m of mods) await K.down(m);
        await M.move(A.x, A.y, { steps: 4 }); await M.down(); await new Promise((r) => setTimeout(r, 60));
        await M.move(B.x, B.y, { steps }); await new Promise((r) => setTimeout(r, 60)); await M.up();
        for (const m of mods.reverse()) await K.up(m);
      }
      else if (a === "scroll") { const { x, y } = pt(p); if (x >= 0 && !Number.isNaN(x)) await M.move(x, y); await M.wheel({ deltaX: +(p.get("dx") || 0), deltaY: +(p.get("dy") || 600) }); }
      else if (a === "type") { const { x, y } = pt(p); if (x >= 0 && !Number.isNaN(x)) { await M.click(x, y); await new Promise((r) => setTimeout(r, 100)); } await K.type(p.get("text") || "", { delay: 12 }); }
      else if (a === "key") { await K.press(p.get("key") || "Enter"); }
      else if (a === "hotkey") { const keys = (p.get("keys") || "").split(",").map((s) => s.trim()).filter(Boolean); for (const k of keys.slice(0, -1)) await K.down(k); if (keys.length) await K.press(keys[keys.length - 1]); for (const k of keys.slice(0, -1).reverse()) await K.up(k); }
      else return T(res, 400, "неизвестное action: " + a);
      await new Promise((r) => setTimeout(r, +(p.get("settle") || 300)));
      return T(res, 200, `ok: ${a}`);
    } catch (e) { return T(res, 500, `ошибка ${a}: ${e.message}`); }
  }

  return T(res, 404, "ГЛАЗА: /look /read?id= /select?id=&q=  РУКИ: /act?action=  ещё: /open /shot /glass/clear");
}
