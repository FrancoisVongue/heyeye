// Клиент к native/x11eye: один постоянный процесс, команды строками, ответы "OK n\n"+n байт.
// Кадр приходит сырым RGBA прямо в память — ни файлов, ни PNG.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "native/x11eye");
const SRC = path.join(ROOT, "native/x11eye.c");

export function build() {
  execFileSync("cc", ["-O2", "-o", BIN, SRC, "-lX11", "-lXext", "-lXtst", "-lXdamage"], { stdio: "inherit" });
}

export class X11 {
  constructor({ display = process.env.DISPLAY || ":99" } = {}) {
    if (!fs.existsSync(BIN) || fs.statSync(BIN).mtimeMs < fs.statSync(SRC).mtimeMs) build();
    // файл кадра в оперативной памяти: помощник пишет туда RGBA, мы читаем одним копированием
    this.shm = `/dev/shm/x11eye-${process.pid}-${display.replace(/\W/g, "")}`;
    this.p = spawn(BIN, [this.shm], { env: { ...process.env, DISPLAY: display }, stdio: ["pipe", "pipe", "inherit"] });
    this.fd = -1;
    this.head = Buffer.alloc(0);  // недочитанная строка заголовка
    this.body = null;             // тело текущего ответа: выделяется сразу нужного размера
    this.filled = 0;
    this.tag = "";
    this.waiting = [];
    this.p.stdout.on("data", (d) => this.feed(d));
    this.p.on("exit", (code) => { for (const w of this.waiting.splice(0)) w.reject(new Error(`x11eye вышел (${code})`)); });
  }

  // разбор потока без склеек: заголовок → буфер ровно на n байт → куски копируются в него по месту
  feed(d) {
    let off = 0;
    while (off < d.length) {
      if (!this.body) {
        const nl = d.indexOf(10, off);
        if (nl < 0) { this.head = Buffer.concat([this.head, d.subarray(off)]); return; }
        const line = Buffer.concat([this.head, d.subarray(off, nl)]).toString();
        this.head = Buffer.alloc(0);
        off = nl + 1;
        const [tag, n] = line.split(" ");
        this.tag = tag; this.body = Buffer.allocUnsafe(+n); this.filled = 0;
      }
      const take = Math.min(this.body.length - this.filled, d.length - off);
      d.copy(this.body, this.filled, off, off + take);
      this.filled += take; off += take;
      if (this.filled === this.body.length) {
        const body = this.body, tag = this.tag; this.body = null;
        const w = this.waiting.shift();
        if (w) { if (tag === "OK") w.resolve(body); else w.reject(new Error(body.toString())); }
      }
    }
  }

  cmd(line) {
    return new Promise((resolve, reject) => { this.waiting.push({ resolve, reject }); this.p.stdin.write(line + "\n"); });
  }
  async text(line) { return (await this.cmd(line)).toString(); }

  async info() { const [W, H] = (await this.text("info")).split(" ").map(Number); this.W = W; this.H = H; return { W, H }; }

  // кадр всего экрана или области: { W, H, data: RGBA }. Пиксели лежат в файле в памяти — читаем
  // ровно w*h*4 байт в свой буфер (одно копирование, без канала).
  async frame(box) {
    if (!this.W) await this.info();
    const b = box ? box.map((v) => Math.round(v)) : null;
    const [w, h] = (await this.text(b ? `capf ${b[0]} ${b[1]} ${b[2]} ${b[3]}` : "capf")).split(" ").map(Number);
    if (this.fd < 0) this.fd = fs.openSync(this.shm, "r");
    const data = new Uint8Array(w * h * 4);
    fs.readSync(this.fd, data, 0, data.length, 0);
    return { W: w, H: h, data };
  }

  reset() { return this.cmd("reset"); }

  // ждать, пока экран успокоится; вернуть, что перерисовалось с прошлого reset/changes
  async changes({ quiet = 150, first = 400, timeout = 3000 } = {}) {
    const lines = (await this.text(`changes ${quiet | 0} ${first | 0} ${timeout | 0}`)).trim().split("\n");
    const [settled, waited, , redrawn] = lines[0].split(" ").map(Number);
    // rects — точные границы реально изменившихся пикселей; redrawn — сколько мест программы перерисовали
    return { settled: !!settled, waited, redrawn, rects: lines.slice(1).filter(Boolean).map((l) => l.split(" ").map(Number)) };
  }

  move(x, y) { return this.cmd(`move ${x | 0} ${y | 0}`); }
  down(button = 1) { return this.cmd(`down ${button}`); }
  up(button = 1) { return this.cmd(`up ${button}`); }
  click(x, y, { button = 1, count = 1 } = {}) { return this.cmd(`click ${button} ${count} ${x | 0} ${y | 0}`); }
  wheel(dx, dy) { return this.cmd(`wheel ${dx | 0} ${dy | 0}`); }
  drag(x1, y1, x2, y2, steps = 16) { return this.cmd(`drag ${x1 | 0} ${y1 | 0} ${x2 | 0} ${y2 | 0} ${steps | 0}`); }
  key(combo, mode = "") { return this.cmd(`key ${combo}${mode ? " " + mode : ""}`); }
  type(text) { return this.cmd("type " + Buffer.from(text, "utf8").toString("hex")); }
  async ptr() { const [x, y] = (await this.text("ptr")).split(" ").map(Number); return { x, y }; }
  async wins() {
    return (await this.text("wins")).split("\n").filter(Boolean).map((l) => {
      const [id, x, y, w, h, ...name] = l.split(" ");
      return { id: +id, box: [+x, +y, +w, +h], name: name.join(" ") };
    });
  }
  close() {
    this.p.stdin.end();
    if (this.fd >= 0) fs.closeSync(this.fd);
    try { fs.unlinkSync(this.shm); } catch {}
  }
}
