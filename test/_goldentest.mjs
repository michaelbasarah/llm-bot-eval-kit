/**
 * End-to-end: start the demo server on a random port and run the golden gate against it.
 * Green with the fake bot, red when the bot throws (apology fallback), red on a bad signature,
 * and the pure judge function on its own. Local sockets only, no key.
 */
process.env.TOYBOT_FAKE = "1";
const { createServer, FALLBACK_TEXT } = await import("../bot/server.mjs");
const { runGolden, judgeTurn, inboundPayload } = await import("../gates/golden.mjs");
const { readFileSync } = await import("node:fs");

let pass = 0, fail = 0;
const ok = (label, cond) => { cond ? pass++ : fail++; console.log(`RESULT ${cond ? "PASS" : "FAIL"}  ${label}`); };
const config = JSON.parse(readFileSync(new URL("../gates/golden.config.json", import.meta.url), "utf8"));

async function withServer(opts, fn) {
  const srv = createServer(opts);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}
const quiet = { timeoutMs: 3000, pollMs: 50 };

// judgeTurn
const FB = { fallbackMarker: config.fallbackMarker };
ok("judge: no reply = fail", judgeTurn(null, {}, FB).level === "fail");
ok("judge: empty = fail", judgeTurn({ text: "  " }, {}, FB).level === "fail");
ok("judge: stack-looking = fail", judgeTurn({ text: "TypeError: x is not a function" }, {}, FB).level === "fail");
ok("judge: fallback = fail", judgeTurn({ text: FALLBACK_TEXT }, {}, FB).level === "fail");
ok("judge: fallback relaxed = warn", judgeTurn({ text: FALLBACK_TEXT }, {}, { ...FB, relaxed: true }).level === "warn");
ok("judge: no keyword = fail", judgeTurn({ text: "Halo" }, { anyMatch: ["jam"] }, FB).level === "fail");
ok("judge: wrong language = fail", judgeTurn({ text: "Open 9-5", lang: "en" }, { anyMatch: ["open"], lang: "id" }, FB).level === "fail");
ok("judge: good reply = ok", judgeTurn({ text: "Jam buka 09:00", lang: "id" }, { anyMatch: ["jam"], lang: "id" }, FB).level === "ok");
ok("payload is WhatsApp-shaped", inboundPayload("1555", "hi").entry[0].changes[0].value.messages[0].text.body === "hi");

// Happy path: fake bot, all scripts clean.
await withServer({}, async (baseUrl) => {
  const r = await runGolden({ baseUrl, config, ...quiet });
  ok(`golden green on the toy bot (${r.scriptsOk}/${r.scripts}, failures: ${JSON.stringify(r.failures)})`, r.failures.length === 0 && r.scriptsOk === r.scripts);
});

// The brain breaks: every turn gets the fallback, the gate must go red.
await withServer({ replyFn: async () => { throw new Error("model down"); } }, async (baseUrl) => {
  const orig = console.error; console.error = () => {};
  const r = await runGolden({ baseUrl, config, ...quiet });
  console.error = orig;
  ok("golden red when the bot throws", r.failures.length > 0 && r.failures.every((f) => f.why.includes("fallback")));
});

// Signed webhook: right secret passes, wrong secret is rejected at the door.
await withServer({ appSecret: "s3cret" }, async (baseUrl) => {
  const good = await runGolden({ baseUrl, config: { ...config, scripts: config.scripts.slice(0, 1) }, appSecret: "s3cret", ...quiet });
  ok("signed payloads accepted", good.failures.length === 0);
  const bad = await runGolden({ baseUrl, config: { ...config, scripts: config.scripts.slice(0, 1) }, appSecret: "wrong", ...quiet });
  ok("bad signature → 401 → gate red", bad.failures.some((f) => f.why.includes("401")));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
