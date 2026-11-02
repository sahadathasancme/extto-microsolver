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
    await page.setUserAgent(UA);
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const t = req.resourceType();
      if (["image", "font", "media", "stylesheet"].includes(t)) req.abort();
      else req.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: remaining() });

    // Wait for the real page, clicking Turnstile if it appears. Poll, don't sleep blindly.
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
      last = { at: new Date().toISOString(), url: data.url, ok: false, ms: Date.now() - t0, error: String(e.message || e) };
      send(502, { status: "error", message: String(e.message || e) });
    } finally {
      busy = false;
    }
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`microsolver listening on ${PORT}`));
