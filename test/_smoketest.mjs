/** The browser gate's pure parts: response triage, viewport options, config + header checks. No browser. */
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyResponse, contextOpts, loadSmokeConfig, checkHeaders } from "../gates/smoke.mjs";

let pass = 0, fail = 0;
const ok = (label, cond) => { cond ? pass++ : fail++; console.log(`RESULT ${cond ? "PASS" : "FAIL"}  ${label}`); };

ok("2xx ok", classifyResponse(200, "document") === "ok");
ok("document 500 fails", classifyResponse(500, "document") === "fail");
ok("script 404 fails", classifyResponse(404, "script") === "fail");
ok("fetch 403 fails", classifyResponse(403, "fetch") === "fail");
ok("image 404 only warns", classifyResponse(404, "image") === "warn");
ok("384px is a phone", contextOpts(384).isMobile && contextOpts(384).userAgent.includes("Mobile"));
ok("1280px is a desktop", !contextOpts(1280).isMobile && contextOpts(1280).userAgent === undefined);

const shipped = loadSmokeConfig(fileURLToPath(new URL("../gates/smoke.config.json", import.meta.url)));
ok("shipped config has routes + both widths", shipped.routes.includes("/") && shipped.widths.join() === "1280,384");

const dir = mkdtempSync(join(tmpdir(), "smoke-"));
const write = (o) => { const p = join(dir, `${Math.random()}.json`); writeFileSync(p, JSON.stringify(o)); return p; };
let threw = false;
try { loadSmokeConfig(write({ routes: [] })); } catch { threw = true; }
ok("empty routes rejected", threw);
const withLogin = loadSmokeConfig(write({ routes: ["/"], login: { path: "/login", fill: { "#pw": "env:SMOKE_PASSWORD" }, submit: "button" } }), { SMOKE_PASSWORD: "pw123" });
ok("env: values resolved in login block", withLogin.login.fill["#pw"] === "pw123");
threw = false;
try { loadSmokeConfig(write({ routes: ["/"], login: { path: "/login", fill: { "#pw": "env:NOPE" } } }), {}); } catch { threw = true; }
ok("missing login secret is a config error", threw);

const h = new Headers({ "x-frame-options": "DENY", "x-content-type-options": "sniff" });
const problems = checkHeaders(h, { "x-frame-options": "^deny$", "x-content-type-options": "^nosniff$", "referrer-policy": "strict" });
ok("header check: wrong value + missing flagged, right value passes", problems.length === 2 && problems.some((p) => p.includes("MISSING")));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
