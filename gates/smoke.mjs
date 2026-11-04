/**
 * Browser smoke gate: loads every configured route at desktop AND phone width in headless Chromium
 * and fails on any of:
 *   - a page (document) response that isn't 2xx (also catches a branded 500 page that still renders),
 *   - a script / stylesheet / fetch / xhr sub-resource ≥ 400,
 *   - an uncaught JS exception,
 *   - any console.error.
 *
 *   BASE_URL=http://localhost:3000 npm run smoke
 *
 * Routes, widths and an optional login step live in gates/smoke.config.json (SMOKE_CONFIG to
 * override). A login block looks like:
 *   "login": { "path": "/login", "fill": { "#password": "env:SMOKE_PASSWORD" }, "submit": "button[type=submit]" }
 *
 * Env:
 *   BASE_URL             (required) app root.
 *   SMOKE_CHROMIUM_PATH  explicit Chromium binary (else playwright-core's own browser cache).
 *   SMOKE_SETTLE_MS      time on each page so async errors surface (default 600).
 *   SMOKE_TIMEOUT_MS     per-navigation timeout (default 20000).
 *   SMOKE_MIN_NAV_GAP_MS minimum gap between navigations (default 0). Set it if your app rate-limits
 *                        per IP: a gate that floods its own rate limiter reads red on a healthy app.
 *   SMOKE_IGNORE_CONSOLE regex; matching console.error lines become warnings (noisy third parties).
 *   SMOKE_EDGE_URL       public URL (through your proxy/CDN) to assert security headers on. Headers
 *                        often come from the proxy, not the app, so only a URL that goes through
 *                        the proxy can tell. Skipped when unset.
 *   SMOKE_SKIP=1         print "skipped" and exit 0 (no browser on this box yet).
 *
 * Exit 0 = clean, 1 = failed, 2 = misconfigured.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";

// Sub-resource types whose 4xx/5xx mean real breakage (a missing image is usually cosmetic).
const HARD_RESOURCE_TYPES = new Set(["script", "stylesheet", "fetch", "xhr", "document"]);
const MOBILE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";

/** "ok" | "fail" | "warn" for one HTTP response seen by the page. */
export function classifyResponse(status, resourceType) {
  if (status < 400) return "ok";
  return HARD_RESOURCE_TYPES.has(resourceType) ? "fail" : "warn";
}

/** Browser context options for a viewport width: ≤ 720px is treated as a phone. */
export function contextOpts(width) {
  const mobile = width <= 720;
  return { viewport: { width, height: mobile ? 832 : 800 }, userAgent: mobile ? MOBILE_UA : undefined, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 };
}

/** Read + validate the config; resolves "env:NAME" values in the login block. */
export function loadSmokeConfig(path, env = process.env) {
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(cfg.routes) || !cfg.routes.length) throw new Error("smoke config: routes must be a non-empty array");
  cfg.widths = (cfg.widths?.length ? cfg.widths : [1280, 384]).map(Number).filter(Boolean);
  if (cfg.login?.fill) {
    for (const [sel, v] of Object.entries(cfg.login.fill)) {
      if (typeof v === "string" && v.startsWith("env:")) {
        const val = env[v.slice(4)];
        if (!val) throw new Error(`smoke config: login needs ${v.slice(4)} in the environment`);
        cfg.login.fill[sel] = val;
      }
    }
  }
  return cfg;
}

/** Check required response headers; returns a list of problems (empty = fine). */
export function checkHeaders(headers, required = {}) {
  const problems = [];
  for (const [name, pattern] of Object.entries(required)) {
    const got = headers.get(name);
    if (!got) problems.push(`${name} MISSING`);
    else if (!new RegExp(pattern, "i").test(got)) problems.push(`${name}: expected /${pattern}/, got "${got}"`);
  }
  return problems;
}

async function main() {
  try { process.loadEnvFile(); } catch {} // .env in the cwd, if there is one
  if (process.env.SMOKE_SKIP === "1") { console.log("⊘ smoke: SMOKE_SKIP=1, browser gate skipped."); return; }
  const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");
  if (!BASE_URL) { console.error("✗ smoke: BASE_URL is required."); process.exit(2); }
  const cfgPath = process.env.SMOKE_CONFIG || fileURLToPath(new URL("./smoke.config.json", import.meta.url));
  let cfg;
  try { cfg = loadSmokeConfig(cfgPath); } catch (err) { console.error(`✗ smoke: ${err.message}`); process.exit(2); }
  const SETTLE_MS = Number(process.env.SMOKE_SETTLE_MS) || 600;
  const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 20000;
  const GAP_MS = Number(process.env.SMOKE_MIN_NAV_GAP_MS) || 0;
  const IGNORE_RE = process.env.SMOKE_IGNORE_CONSOLE ? new RegExp(process.env.SMOKE_IGNORE_CONSOLE, "i") : null;

  let chromium;
  try { ({ chromium } = await import("playwright-core")); } catch {
    console.error("✗ smoke: playwright-core is not installed. Run: npm install && npx playwright-core install chromium");
    process.exit(2);
  }

  const failures = [], warnings = [];
  let checked = 0, lastNav = 0;
  const fail = (vp, url, why) => failures.push({ vp, url, why });
  const warn = (vp, url, why) => warnings.push({ vp, url, why });

  function arm(page, vp, url) {
    page.on("pageerror", (err) => fail(vp, url, `uncaught JS exception: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      if (IGNORE_RE?.test(msg.text())) return warn(vp, url, `console.error (ignored): ${msg.text()}`);
      fail(vp, url, `console.error: ${msg.text()}`);
    });
    page.on("response", (res) => {
      const rt = res.request().resourceType();
      const verdict = classifyResponse(res.status(), rt);
      if (verdict === "ok") return;
      const what = rt === "document" ? `page returned ${res.status()}` : `${rt} ${res.request().method()} ${res.url()} → ${res.status()}`;
      verdict === "fail" ? fail(vp, url, what) : warn(vp, url, what);
    });
    page.on("requestfailed", (req) => {
      if (HARD_RESOURCE_TYPES.has(req.resourceType())) fail(vp, url, `request failed (${req.resourceType()}): ${req.url()} (${req.failure()?.errorText})`);
    });
  }

  async function pace() {
    const wait = GAP_MS - (Date.now() - lastNav);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNav = Date.now();
  }

  async function sweep(width) {
    const vp = `${width}px`;
    const browser = await chromium.launch({ headless: true, executablePath: process.env.SMOKE_CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
    const ctx = await browser.newContext(contextOpts(width));
    try {
      if (cfg.login) {
        const page = await ctx.newPage();
        arm(page, vp, `${BASE_URL}${cfg.login.path}`);
        await pace();
        await page.goto(`${BASE_URL}${cfg.login.path}`, { waitUntil: "load", timeout: TIMEOUT_MS });
        for (const [sel, val] of Object.entries(cfg.login.fill)) await page.fill(sel, val);
        // A bad password usually re-renders the login page with 200, so wait to LEAVE it.
        await Promise.all([page.waitForURL((u) => !u.pathname.startsWith(cfg.login.path), { timeout: TIMEOUT_MS }), page.click(cfg.login.submit)]);
        await page.close();
        checked++;
      }
      for (const route of cfg.routes) {
        const url = `${BASE_URL}${route}`;
        checked++;
        const page = await ctx.newPage();
        arm(page, vp, url);
        try {
          await pace();
          await page.goto(url, { waitUntil: "load", timeout: TIMEOUT_MS });
          await page.waitForTimeout(SETTLE_MS);
        } catch (err) {
          fail(vp, url, `navigation error: ${err.message.split("\n")[0]}`);
        } finally {
          await page.close().catch(() => {});
        }
      }
    } catch (err) {
      fail(vp, `${BASE_URL}${cfg.login?.path || ""}`, `login failed: ${err.message.split("\n")[0]}`);
    } finally {
      await browser.close().catch(() => {});
    }
  }

  console.log(`▶ smoke: ${BASE_URL} · ${cfg.routes.length} routes @ ${cfg.widths.join("px, ")}px`);
  const edge = (process.env.SMOKE_EDGE_URL || "").replace(/\/+$/, "");
  if (!edge) console.log("  • security headers: skipped (set SMOKE_EDGE_URL)");
  else {
    try {
      const res = await fetch(`${edge}/`, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      const problems = checkHeaders(res.headers, cfg.requiredHeaders);
      for (const p of problems) fail("headers", edge, p);
      console.log(`  • security headers: ${problems.length ? "RED" : "ok"}`);
    } catch (err) {
      warn("headers", edge, `could not reach the edge: ${err.message}`);
    }
  }
  const t0 = Date.now();
  for (const w of cfg.widths) {
    process.stdout.write(`  • ${w}px …`);
    await sweep(w);
    console.log(failures.some((f) => f.vp === `${w}px`) ? " RED" : " ok");
  }
  const ms = Date.now() - t0;
  console.log("");
  for (const w of warnings.slice(0, 10)) console.warn(`  ⚠ [${w.vp}] ${w.url} → ${w.why}`);
  if (failures.length) {
    console.error(`✗ smoke FAILED: ${failures.length} hard failure(s) across ${checked} page loads (${ms}ms). Promote BLOCKED.`);
    for (const f of failures) console.error(`   [${f.vp}] ${f.url}\n      → ${f.why}`);
    process.exit(1);
  }
  console.log(`✓ smoke OK: ${checked} page loads clean (${ms}ms).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
