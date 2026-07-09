// Eye daemon — ТОНКИЙ и ЗАМОРОЖЕННЫЙ. Подключается к Canary ОДИН раз (одно Allow навсегда)
// и на каждый запрос зовёт свежий routes.js. Логику меняю в routes.js/*.js — демон не трогаю,
// поэтому Chrome больше никогда не спрашивает Allow.
//   node eye/src/daemon.js
import http from "node:http";
import puppeteer from "puppeteer-core";

const WS = "ws://127.0.0.1:9222/devtools/browser";
const PORT = parseInt(process.env.EYE_PORT || "9223", 10);
const fresh = (mod) => import(`${mod}?t=${Date.now()}`);

const browser = await puppeteer.connect({ browserWSEndpoint: WS, defaultViewport: null, protocolTimeout: 60000 });
console.log("[eye] подключился к Canary (единственное Allow)");

async function pickPage(filter) {
  let ps = [];
  for (let i = 0; i < 8 && !ps.length; i++) { ps = (await browser.pages()).filter((x) => !/^(chrome|devtools):/.test(x.url())); if (!ps.length) await new Promise((r) => setTimeout(r, 250)); }
  if (filter) { const m = ps.find((x) => x.url().includes(filter)); if (!m) throw new Error(`нет вкладки по "${filter}"`); return m; }
  for (const x of ps) { try { if ((await x.evaluate(() => document.visibilityState)) === "visible") return x; } catch {} }
  return ps[0];
}

http.createServer(async (req, res) => {
  try { const { handle } = await fresh("./routes.js"); await handle({ req, res, browser, pickPage, fresh }); }
  catch (e) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String(e.message || e) })); }
}).listen(PORT, "127.0.0.1", () => console.log(`[eye] http://127.0.0.1:${PORT}  (routes.js — горячий)`));

process.on("SIGINT", async () => { await browser.disconnect(); process.exit(0); });
