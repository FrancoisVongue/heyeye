// Сквозная проверка на X11: виртуальный экран + браузер с песочницей → разбор → действия → проверка.
//   sh scripts/display.sh && DISPLAY=:99 node test/x11-loop.mjs
// Проверяет руки (перетаскивание, двойной клик, ввод с кириллицей, сочетания клавиш, прокрутка),
// сообщения об изменениях экрана и чтение текста. Выход 1 при любом провале.
import { X11 } from "../src/x11.js";
import { perceive } from "../src/perceive.js";
import { readRegion, warmup } from "../src/ocr.js";

const x = new X11();
await warmup();
const fold = (s) => s.toLowerCase().replace(/[авеёкмнорстухі]/g, (c) => ({ а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", і: "i" })[c]).replace(/\s+/g, "");
const read = async (box) => (await readRegion(await x.frame(), box)).lines.map((l) => l.text).join(" ");
let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`); if (!ok) fails++; };
const act = async (fn) => { await x.reset(); await fn(); return x.changes(); };
const center = (b) => [b[0] + b[2] / 2, b[1] + b[3] / 2];

// чистое состояние песочницы
await act(() => x.key("F5"));
await new Promise((r) => setTimeout(r, 800));

const t0 = performance.now();
const r = await perceive(await x.frame());
check("разбор экрана", r.nodes.length >= 10, `${r.nodes.length} узлов за ${Math.round(performance.now() - t0)} мс`);
const byText = (q) => r.nodes.find((n) => n.text && fold(n.text).includes(fold(q)));
const big = (pred) => r.nodes.filter((n) => !n.text && pred(n)).sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0];

const dbl = byText("double-click"), field = byText("печатай"), zoneLabel = byText("сюда"), rc = byText("right-click");
check("нашлись подписи песочницы", !!(dbl && field && zoneLabel && rc));
const zone = big((n) => n.box[0] <= zoneLabel.box[0] && n.box[1] <= zoneLabel.box[1] && n.box[0] + n.box[2] >= zoneLabel.box[0] + zoneLabel.box[2] && n.box[2] > 150);
const box = big((n) => n.box[0] < 300 && n.box[1] < 330 && n.box[1] > 150 && n.box[2] > 80 && n.box[2] < 200);

{ // перетаскивание: квадрат уходит со своего места и появляется в зоне
  const [ax, ay] = center(box.box), [bx, by] = center(zone.box);
  const ch = await act(() => x.drag(ax, ay, bx, by, 16));
  const inter = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
  check("перетаскивание: изменились место квадрата и зона", ch.rects.some((q) => inter(q, box.box)) && ch.rects.some((q) => inter(q, zone.box)), `${ch.rects.length} мест`);
}
{ // двойной клик: счётчик на кнопке
  const [cx, cy] = center(dbl.box);
  await act(() => x.click(cx, cy, { count: 2 }));
  const t = await read([dbl.box[0] - 20, dbl.box[1] - 10, dbl.box[2] + 40, dbl.box[3] + 20]);
  check("двойной клик", fold(t).includes("(1"), `"${t}"`);
}
{ // ввод: кириллица, латиница, цифры, знаки — при английской раскладке
  const fb = [field.box[0], field.box[1], 430, 100];
  const text = "Привет, hello 123! Ёж";
  await act(async () => { await x.click(field.box[0] + 40, field.box[1] + 30); await x.type(text); });
  const t = await read(fb);
  check("ввод текста", fold(t).includes(fold("hello123")) && fold(t).includes(fold("привет")), `"${t}"`);
  await act(() => x.key("ctrl+a"));
  const ch = await act(() => x.key("BackSpace"));
  const t2 = await read(fb);
  // поле пустое → снова видна подсказка «печатай сюда...» (модель иногда читает «й» как «и»)
  check("сочетание Ctrl+A и BackSpace", ch.rects.length > 0 && fold(t2).includes(fold("печата")) && !fold(t2).includes(fold("hello")), `"${t2}"`);
}
{ // ничего не делать — ничего не должно измениться
  const ch = await act(() => x.move(700, 700));
  check("пустое движение мыши: «ничего не изменилось»", ch.rects.length === 0 && ch.settled, `${ch.waited} мс`);
}
{ // прокрутка списка под строками «строка N»
  const row = byText("строка 1") || byText("строка1");
  const [sx, sy] = center(row.box);
  const ch = await act(async () => { await x.move(sx + 100, sy + 60); await x.wheel(0, 3); });
  check("прокрутка: список сдвинулся и успокоился", ch.rects.length > 0 && ch.settled, `ждал ${ch.waited} мс`);
}
x.close();
console.log(fails ? `\nПРОВАЛОВ: ${fails}` : "\nвсё прошло");
process.exit(fails ? 1 : 0);
