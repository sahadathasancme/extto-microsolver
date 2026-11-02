# extto-microsolver

A tiny FlareSolverr-compatible solver built for 512 MB free tiers (Render / Koyeb),
where FlareSolverr and Byparr both OOM-crashed on ext.to in Nov 2026.

## Why it might fit where the others did not

- One browser, one page, one request at a time. A second request gets HTTP 429,
  never a second browser.
- `--single-process`, `--renderer-process-limit=1`, V8 heap capped at 256 MB,
  `--disable-dev-shm-usage` (Render's /dev/shm is only 64 MB), images/fonts/media
  blocked at request level, no Xvfb, no GPU.
- Browser is killed after every solve, so memory cannot leak across requests.
- ext.to's managed challenge does not clear by waiting alone, so the solver
  clicks the Turnstile widget when one appears, then waits for the real page.

## API (same shape as FlareSolverr, so extto-search needs no code change)

```
POST /v1   {"cmd":"request.get","url":"https://ext.to/browse/?q=ubuntu","maxTimeout":60000}
GET  /health   {"status":"ok","busy":false,"mem":{"rss":..,"heap":..}}
```

Set `FLARESOLVERR_URL` on the Vercel extto-search project to this service's URL,
redeploy, and test search end-to-end.

## Deploy

Render (free): create a Web Service from this repo (Dockerfile), no card,
env `PORT` is injected by Render. Koyeb (free): same Dockerfile, but Koyeb
reportedly now requires a card with a $29 pre-authorisation hold.

## Honest limits

- This is still a real Chromium. 512 MB is borderline by design; the test may
  still OOM, and 0.1 vCPU will make solves slow (60s timeout, 120s cap).
- A clearance is bound to the solving IP + UA + TLS fingerprint, so the solver
  must be the one fetching — a clearance minted elsewhere will not transfer.
- If this OOMs too, the next honest step is a 2 GB host (borrowed PC, Azure
  for Students VM, or Railway once sign-ups reopen), not another 512 MB tier.
