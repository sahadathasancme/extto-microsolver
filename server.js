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
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

let busy = false;

function memMB() {
  const u = process.memoryUsage();
  return { rss: Math.round(u.rss / 1048576), heap: Math.round(u.heapUsed / 1048576) };
}

async function solve(url, maxTimeout) {
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
    await page.setUserAgent(UA);
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const t = req.resourceType();
      if (["image", "font", "media", "stylesheet"].includes(t)) req.abort();
      else req.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: maxTimeout });

    // Wait for the real page, clicking Turnstile if it appears. Poll, don't sleep blindly.
    const deadline = Date.now() + maxTimeout;
    let html = "";
    while (Date.now() < deadline) {
      html = await page.content();
      const isChallenge =
        /just a moment|challenges\.cloudflare|cf-turnstile|cf_chl/i.test(html.slice(0, 8000)) ||
        (await page.$("iframe[src*='challenges.cloudflare.com']").catch(() => null));
      if (!isChallenge) break;
      // Try to click the Turnstile widget (in its iframe, if reachable).
      try {
        const frames = page.frames();
        for (const f of frames) {
          if (/challenges\.cloudflare\.com/.test(f.url())) {
            const box = await f.$("input[type='checkbox'], div[role='checkbox']").catch(() => null);
            if (box) {
              const b = await box.boundingBox();
              if (b) {
                await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
                await box.click();
              }
            }
          }
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
    html = await page.content();
    if (/just a moment|challenges\.cloudflare/i.test(html.slice(0, 8000))) {
      throw new Error("Challenge still present after timeout");
    }
    const cookies = await page.cookies();
    return { url: page.url(), response: html, userAgent: UA, cookies };
  } finally {
    await browser.close().catch(() => {});
  }
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.url === "/" || req.url === "/health") return send(200, { status: "ok", busy, mem: memMB() });
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
    try {
      const solution = await solve(data.url, Math.min(data.maxTimeout || 60000, 120000));
      send(200, { status: "ok", solution, mem: memMB() });
    } catch (e) {
      send(502, { status: "error", message: String(e.message || e) });
    } finally {
      busy = false;
    }
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`microsolver listening on ${PORT}`));
