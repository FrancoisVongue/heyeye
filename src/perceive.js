// Разбор кадра экрана по пикселям: картинки и цветные контейнеры (islands.js) + текст (textgroup.js/ocr.js)
// + кнопки, карточки по краям, боковые панели, бары, иконки, детализация крупных контейнеров.
// Вход — сырой кадр { W, H, data:RGBA } прямо с экрана (или PNG-буфер для офлайн-тестов).
// Модули грузятся один раз (статические импорты): раньше они перезагружались на КАЖДЫЙ запрос.
import * as I from "./islands.js";
import { textBlocks } from "./textgroup.js";
import { detectBoxes } from "./ocr.js";
import { solidify } from "./buttons.js";
import { cut as xyCut } from "./xycut.js";

const ovl = (a, b) => { const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]), x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]); const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0); return i / (Math.min(a[2] * a[3], b[2] * b[3]) + 1e-9); };

// Вывод для ИИ: дерево в ПОРЯДКЕ ЧТЕНИЯ (сверху↓, слева→) с ПРЕВЬЮ текста (первые ~8 слов).
// Всё вложено под своим контейнером; верхний уровень = прямо под ЭКРАНОМ (ничего не висит бесхозным).
export function treeText(nodes, dpr, maxD = 99) {
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

// ОБЩИЙ АЛГОРИТМ: КАПЛЯ (картинки + цветные контейнеры) + ТЕКСТ (блоки по размеру).
// XY-cut — только тихий последний ФОЛБЭК, если текста почти нет (текст отрисован картинкой).
// opts: обычный объект { fast, text, tol, maxDepth, detMaxW, maxW } или URLSearchParams (старые тесты).
export async function perceive(src, opts = {}) {
  const p = typeof opts.get === "function" ? opts : { get: (k) => (opts[k] == null ? null : String(opts[k])) };
  const frame = src && src.data && src.W ? src : I.decodeFrame(src); // сырой кадр с экрана; PNG — только в тестах
  // Чтение текста запускаем СРАЗУ: сам прогон модели идёт в потоках onnxruntime, пока главный поток считает
  // CV (капля/грань/панели/иконки). Забираем результат позже → чтение прячется под CV.
  // FAST-режим (`fast=1`): только ПОИСК текста (боксы без содержимого) вместо полного чтения — чтение ~85%
  // времени. ИИ добирает текст нужной области через /read. Слой/иконки/картинки/позиции текста те же.
  const fast = p.get("fast") === "1";
  const ocrP = fast
    ? detectBoxes(frame).catch(() => ({ boxes: [] }))
    : (p.get("text") !== "0" ? textBlocks(frame).catch(() => ({ blocks: [] })) : Promise.resolve({ blocks: [] }));
  const r = I.detect(frame, { tol: +(p.get("tol") || 12), maxDepth: +(p.get("maxDepth") || 3), maxW: +(p.get("detMaxW")) || 760 });
  const images = r.nodes.filter((n) => n.image);
  const regions = r.nodes.filter((n) => !n.image && n.shape !== "surface" && n.depth <= 1 && n.box[2] * n.box[3] > 0.004 * r.W * r.H);
  // ДАУНСКЕЙЛ = ОПЦИЯ (агент решает сам): мелкий проход (грань-карточки/панели/ИКОНКИ) по умолчанию @1577,
  // но `?maxW=native` (или 0) → НАТИВНОЕ разрешение (без даунскейла — ловит самые мелкие иконки/текст, но
  // медленнее и больше кандидатов), `?maxW=2400` → своя ширина. Боксы всегда в НАТИВНЫХ px → координаты
  // сходятся при любом maxW. `?detMaxW=N` — то же для грубого прохода detect (по умолчанию 760).
  const mp = p.get("maxW");
  const fineW = mp == null ? 1577 : (mp === "native" || mp === "0") ? r.W : (+mp > 0 ? +mp : 1577);
  // грань-карточки и боковые панели зависят ТОЛЬКО от кадра → считаем их тоже ДО ожидания OCR (под OCR)
  const canvasy = regions.length <= 2 && images.length === 0;
  let erRects = [], spPanels = [];
  try { erRects = I.edgeRects(frame, { maxW: fineW, ...(canvasy ? { perimMin: 0.4, emptyMin: 0.1 } : {}) }).rects; spPanels = I.sidePanels(frame, { maxW: fineW }).panels; } catch (e) {}
  // ИКОНКИ: CV-часть (поиск блобов) зависит ТОЛЬКО от кадра, не от текста → считаем ЗДЕСЬ, ПОД OCR
  // (переиспользует мемоизированную buildWall от edgeRects). Дедуп относительно текста — позже.
  let iconCands = [];
  try { iconCands = I.iconPass(frame, { maxW: fineW }).icons; } catch (e) {}
  const tg = await ocrP;                        // забираем OCR (крутился параллельно — уже почти готов)
  // текст ВНУТРИ картинки (OCR-мусор на фото) выкидываем ДО solidify, чтобы он не стал ложной «кнопкой»
  let blocks;
  if (fast) {
    // FAST: боксы-регионы текста БЕЗ содержимого; solidify (кнопки) и гибрид пропускаем — им нужен текст.
    blocks = (tg.boxes || []).filter((b) => !images.some((im) => ovl(b.box, im.box) > 0.55)).map((b) => ({ box: b.box, text: "" }));
  } else {
    blocks = tg.blocks.filter((b) => !images.some((im) => ovl(b.box, im.box) > 0.55));
    try { blocks = solidify(frame, blocks); } catch (e) {}
  }
  const nodes = []; let id = 0;
  for (const im of images) nodes.push({ id: id++, parent: -1, shape: "image", image: true, depth: 0, box: im.box });
  for (const c of regions) nodes.push({ id: id++, parent: -1, shape: c.shape, image: false, depth: 0, box: c.box, colors: c.colors, edge: c.edge });
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
  let mode = fast ? "regions+textboxes(fast)" : "regions+text";
  if (!fast && blocks.length < 4 && regions.length < 3) {               // текста нет (нарисован картинкой) → XY-фолбэк (в fast пропускаем)
    const xr = xyCut(frame, { gapFrac: 0.011 });
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
  // ИКОНКИ: мелкие компактные грань-карманы, которые edgeRects отбросил (круглые аватары, play/меню/лайк,
  // поиск). Добавляем те, что НЕ дубль: на тексте/кнопке (ovl>0.45) = это текст → пропуск; на фото (ovl>0.55)
  // = деталь картинки → пропуск; почти тот же бокс контейнера (IoU>0.5) = дубль. ВНУТРИ контейнера (бар/
  // карточка) оставляем — там иконки и живут. Затем назначаем иконкам родителя (наименьший контейнер).
  try {
    const iouI = (a, b) => { const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]), x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]); const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0); return i / (a[2] * a[3] + b[2] * b[3] - i + 1e-9); };
    const added = [];
    for (const b of iconCands) {                 // кандидаты посчитаны ВЫШЕ под OCR (см. iconCands)
      // ФОТО-ПЛОСКОЕ = много ЦВЕТОВ (≥128) + МАЛО граней (<0.08) + крупное: это видео/картинка (флаг в мониторе
      // Kdenlive: colors=193, edge=0.03), которую classify НЕ пометил image из-за низкой плотности граней (слишком
      // гладкое). Изолированные грань-блобы на ней (герб/текстура) — ЛОЖНЫЕ иконки → давим как на image.
      const photoFlat = (n) => n.colors >= 128 && n.edge != null && n.edge < 0.08 && A(n.box) > 0.02 * r.W * r.H;
      const dup = nodes.some((n) => { if (n.shape === "text" || n.shape === "button") return iouI(b.box, n.box) > 0.4; const o = ovl(b.box, n.box); if (o < 0.3) return false; if (n.image || photoFlat(n)) return o > 0.55 && !b.grid; return iouI(b.box, n.box) > 0.5; }); // b.grid = член решётки-тулбара → НЕ деталь фото, оставляем даже внутри image/фото-региона
      if (dup) continue;
      const node = { id: id++, parent: -1, shape: b.shape, image: b.image, depth: 0, box: b.box };
      nodes.push(node); added.push(node);
    }
    for (const n of added) { let best = -1, ba = Infinity; for (const m of nodes) if (m.id !== n.id && has(m, n)) { const a = A(m.box); if (a < ba) { ba = a; best = m.id; } } n.parent = best; }
  } catch (e) {}
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
