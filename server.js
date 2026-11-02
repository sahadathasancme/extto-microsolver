// extto-microsolver — single-process, single-request Chromium solver for 512 MB hosts.
// FlareSolverr-compatible POST /v1: {"cmd":"request.get","url":"...","maxTimeout":60000}
//   -> {"status":"ok","solution":{"url","response","userAgent","cookies":[]}}
// Design rules (why FlareSolverr/Byparr OOM'd at 512 MB and this might not):
//   - ONE browser, ONE page, ONE request at a time (a busy request gets 429, never a second browser).
//   - --single-process + --renderer-process-limit=1 + V8 heap cap, no Xvfb, no GPU, no extensions.
//   - Images, fonts, media and stylesheets blocked at the request level (ext.to HTML is what we need).
//   - Browser is killed after EVERY solve, so memory cannot leak across requests.
//   - ext.to's managed challenge does not clear by waiting alone — the solver clicks the
//     Turnstile widget when one appears, then waits for the real page.
// NOTE: this is still a real Chromium. 512 MB is borderline by design; it is a test,
// not a promise. If it OOMs, the only honest fix is a 2 GB host.

const http = require("http");
const puppeteer = require("puppeteer-core");

const PORT = process.env.PORT || 8191;
const CHROME = process.env.CHROME_PATH || "/usr/bin/chromium";
// No hardcoded UA: the solver reports the browser's own UA, so the UA, JS fingerprint
// and TLS stack all describe the same browser (a hardcoded Chrome/126 UA on a different
// Chromium build is itself a detectable mismatch).

// Human-like mouse move: stepped path with a little jitter, not a teleport to the target.
async function humanMove(page, x, y) {
  const start = { x: 640, y: 200 };
  try {
    const pos = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })).catch(() => start);
    void pos;
  } catch {}
  const steps = 18;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t);
    const mx = start.x + (x - start.x) * ease + (Math.random() - 0.5) * 6;
    const my = start.y + (y - start.y) * ease + (Math.random() - 0.5) * 6;
    await page.mouse.move(mx, my);
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 40));
  }
}

// Click the Turnstile widget itself. The previous version hunted for a checkbox input
// inside the cross-origin challenge iframe, which it cannot reliably reach. The widget
// on the parent page is an <iframe> (src challenges.cloudflare.com) inside a
// .cf-turnstile container — clicking that element, after scrolling it into view and
// moving the mouse to it like a human, is how a real visitor passes it.
async function clickTurnstile(page) {
  const handles = await page.$$(
    "iframe[src*='challenges.cloudflare.com'], .cf-turnstile iframe, .cf-turnstile"
  );
  for (const h of handles) {
    try {
      await h.scrollIntoViewIfNeeded().catch(() => {});
      const box = await h.boundingBox();
      if (!box || box.width < 10 || box.height < 10) continue;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await humanMove(page, cx, cy);
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));
      await page.mouse.down();
      await new Promise((r) => setTimeout(r, 80 + Math.random() * 120));
      await page.mouse.up();
      return { clicked: true, at: `${Math.round(cx)},${Math.round(cy)}` };
    } catch {}
  }
  return { clicked: false };
}

let busy = false;
// Last solve outcome, kept so a client that disconnects can still read the result via /last.
let last = null;

function memMB() {
  const u = process.memoryUsage();
  return { rss: Math.round(u.rss / 1048576), heap: Math.round(u.heapUsed / 1048576) };
}

async function solve(url, maxTimeout) {
  const started = Date.now();
  // One deadline for the WHOLE solve (launch + goto + challenge wait). The first version
  // stacked goto's timeout on top of the wait timeout, so a slow 0.1-vCPU solve could run
  // past the client's timeout and its result was lost even though the server later cleared.
  const deadline = started + maxTimeout;
  const remaining = () => Math.max(0, deadline - Date.now());
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage", // /dev/shm is 64 MB on Render; use /tmp instead
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-features=Translate,MediaRouter",
      "--single-process",
      "--renderer-process-limit=1",
      "--js-flags=--max-old-space-size=256",
      "--blink-settings=imagesEnabled=false",
      "--window-size=1280,900",
    ],
  });
  try {
    const page = await browser.newPage();
    // Light stealth patches: hide the automation flags a managed challenge scores on.
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
      window.chrome = window.chrome || { runtime: {} };
    });
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const t = req.resourceType();
      if (["image", "font", "media", "stylesheet"].includes(t)) req.abort();
      else req.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: remaining() });

    // Wait for the real page, clicking Turnstile if it appears. Poll, don't sleep blindly.
    // Click at most twice: a second click after a few seconds, in case the first landed
    // before the widget was ready. Diagnostics are attached to the thrown error so /last
    // shows whether a widget was even found — the key unknown from the last test.
    let html = "";
    let widgetFound = false;
    let clickInfo = null;
    let clicks = 0;
    while (Date.now() < deadline) {
      html = await page.content();
      const isChallenge =
        /just a moment|challenges\.cloudflare|cf-turnstile|cf_chl/i.test(html.slice(0, 8000)) ||
        (await page.$("iframe[src*='challenges.cloudflare.com']").catch(() => null));
      if (!isChallenge) break;
      const probe = await page.$$("iframe[src*='challenges.cloudflare.com'], .cf-turnstile").catch(() => []);
      widgetFound = widgetFound || probe.length > 0;
      if (clicks < 2) {
        clickInfo = await clickTurnstile(page).catch(() => ({ clicked: false }));
        clicks++;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    html = await page.content();
    if (/just a moment|challenges\.cloudflare/i.test(html.slice(0, 8000))) {
      const e = new Error("Challenge still present after timeout");
      e.detail = { widgetFound, clicks, clickInfo };
      throw e;
    }
    const cookies = await page.cookies();
    const realUA = await page.evaluate(() => navigator.userAgent).catch(() => "");
    return { url: page.url(), response: html, userAgent: realUA, cookies };
  } finally {
    // Graceful close can hang on single-process Chromium under CPU starvation, so
    // race it and force-kill the browser process if it does not die in 5s.
    try {
      await Promise.race([
        browser.close(),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    } catch {}
    try {
      const proc = browser.process();
      if (proc && !proc.killed) proc.kill("SIGKILL");
    } catch {}
  }
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.url === "/" || req.url === "/health") return send(200, { status: "ok", busy, mem: memMB(), last });
  if (req.url === "/last") return send(200, { last });
  if (req.method !== "POST" || req.url !== "/v1") return send(404, { error: "not found" });
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    if (busy) return send(429, { status: "error", message: "Solver busy — one request at a time" });
    let data;
    try {
      data = JSON.parse(body || "{}");
    } catch {
      return send(400, { status: "error", message: "Bad JSON" });
    }
    if (data.cmd !== "request.get" || !data.url) {
      return send(400, { status: "error", message: "Expected {cmd:'request.get', url}" });
    }
    busy = true;
    const t0 = Date.now();
    try {
      const solution = await solve(data.url, Math.min(data.maxTimeout || 60000, 120000));
      last = { at: new Date().toISOString(), url: data.url, ok: true, ms: Date.now() - t0, htmlLen: solution.response.length, title: (solution.response.match(/<title[^>]*>([^<]*)/i) || [])[1] || "" };
      send(200, { status: "ok", solution, mem: memMB() });
    } catch (e) {
      last = { at: new Date().toISOString(), url: data.url, ok: false, ms: Date.now() - t0, error: String(e.message || e), detail: e.detail || null };
      send(502, { status: "error", message: String(e.message || e) });
    } finally {
      busy = false;
    }
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`microsolver listening on ${PORT}`));
