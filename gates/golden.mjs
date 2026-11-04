/**
 * Golden-conversation gate: drives scripted customer conversations through the SAME /webhook a
 * real WhatsApp number hits, reads each reply back over HTTP, and asserts on it.
 *
 * What it catches: a broken API key, a crashed pipeline, or a wrong-language reply all show up as
 * NO reply or the bot's canned apology fallback. The fallback is the precise regression signal: it
 * only fires when the model call errored, so a build that breaks the brain fails here before prod.
 * Content checks (`anyMatch`) are broad on purpose because model phrasing varies; a real breakage
 * produces the fallback or nothing, not a slightly different sentence.
 *
 *   BASE_URL=http://localhost:3000 npm run golden
 *
 * Env:
 *   BASE_URL           (required) app root.
 *   GOLDEN_CONFIG      scripts file (default gates/golden.config.json).
 *   APP_SECRET         if set, each payload is signed with x-hub-signature-256, like Meta does.
 *   GOLDEN_AUTH        optional Authorization header for reading transcripts back.
 *   GOLDEN_TIMEOUT_MS  per-reply wait (default 25000).  GOLDEN_POLL_MS  poll interval (default 500).
 *   GOLDEN_RELAXED=1   downgrade fallback/content/language checks to warnings (plumbing-only run
 *                      without a key). "No reply" stays a hard failure.
 *
 * Exit 0 = clean, 1 = failed, 2 = misconfigured. A deploy script can gate on that.
 *
 * The server contract is two endpoints (adapt `messages()` if yours differ):
 *   POST /webhook                                 WhatsApp Cloud API inbound payload
 *   GET  /api/conversations/:from/messages?after  → { messages: [{ id, direction: "in"|"out", text, lang? }] }
 */
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";

// Replies that look like a leaked stack trace or an undefined render, not a real answer.
const ERRORY = /\b(error|undefined|nan|cannot read|is not a function|at \/|\[object)\b/i;

/** A WhatsApp Cloud API inbound text payload. The phone ids are Meta's documented test placeholders. */
export function inboundPayload(from, text, phoneId = "TEST_PHONE_ID") {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "WABA_ID",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "15550000000", phone_number_id: phoneId },
          contacts: [{ profile: { name: "Golden Path" }, wa_id: from }],
          messages: [{ from, id: `wamid.golden.${from}.${Date.now()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
        },
      }],
    }],
  };
}

/**
 * Judge one reply. Returns { level: "ok" | "fail" | "warn", why }.
 * Hard (always fail): no reply, empty, error-looking. Relaxable: fallback, content, language.
 */
export function judgeTurn(reply, turn, { fallbackMarker, relaxed = false }) {
  if (reply == null) return { level: "fail", why: "no reply within timeout (pipeline broken or very slow)" };
  const text = String(reply.text ?? "");
  if (!text.trim()) return { level: "fail", why: "reply was empty" };
  if (ERRORY.test(text)) return { level: "fail", why: `reply looks like an error/stack: "${text.slice(0, 80)}"` };
  const soft = relaxed ? "warn" : "fail";
  if (fallbackMarker && text.toLowerCase().includes(fallbackMarker.toLowerCase())) return { level: soft, why: `bot errored → apology fallback: "${text.slice(0, 80)}"` };
  if (turn.anyMatch && !turn.anyMatch.some((k) => text.toLowerCase().includes(k.toLowerCase()))) return { level: soft, why: `reply missing all of [${turn.anyMatch.join(", ")}]: "${text.slice(0, 80)}"` };
  if (turn.lang && reply.lang && reply.lang !== turn.lang) return { level: soft, why: `wrong language: got ${reply.lang}, want ${turn.lang}` };
  return { level: "ok" };
}

export async function runGolden({ baseUrl, config, appSecret = "", auth = "", timeoutMs = 25000, pollMs = 500, relaxed = false, log = () => {} }) {
  baseUrl = baseUrl.replace(/\/+$/, "");
  const failures = [], warnings = [];
  let turnsRun = 0, scriptsOk = 0;
  const runTag = String(Date.now()).slice(-6); // unique ids per run → no history or language bleed

  async function send(from, text) {
    const body = JSON.stringify(inboundPayload(from, text));
    const headers = { "content-type": "application/json" };
    if (appSecret) headers["x-hub-signature-256"] = "sha256=" + crypto.createHmac("sha256", appSecret).update(body).digest("hex");
    return (await fetch(`${baseUrl}/webhook`, { method: "POST", headers, body })).status;
  }

  async function messages(from, after = 0) {
    const res = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent(from)}/messages?after=${after}`, { headers: auth ? { authorization: auth } : {} });
    if (res.status === 404) return [];
    // Any other non-2xx is config/auth trouble, not "no reply yet": say so instead of timing out.
    if (!res.ok) throw new Error(`transcript read → HTTP ${res.status} (check GOLDEN_AUTH / server config)`);
    if (!(res.headers.get("content-type") || "").includes("json")) throw new Error("transcript read returned non-JSON (redirected to a login page?)");
    return (await res.json()).messages || [];
  }

  /** Wait for NEW outbound messages after `after`; joins them (a turn can send several). */
  async function waitForReply(from, after) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const outs = (await messages(from, after)).filter((m) => m.direction === "out");
      if (outs.length) return { text: outs.map((m) => m.text || "").join("\n").trim(), lang: outs.at(-1).lang ?? null };
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return null;
  }

  try {
    for (const [i, script] of config.scripts.entries()) {
      const from = `1555010${runTag}${String(i + 1).padStart(2, "0")}`; // fictional 555-01xx range, fresh per script
      let clean = true;
      for (const [t, turn] of script.turns.entries()) {
        const where = `${script.name}#${t + 1}`;
        const before = (await messages(from)).reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);
        const ack = await send(from, turn.text);
        if (ack !== 200) { failures.push({ where, why: `/webhook did not ACK (got ${ack})` }); clean = false; break; }
        const reply = await waitForReply(from, before);
        turnsRun++;
        const v = judgeTurn(reply, turn, { fallbackMarker: config.fallbackMarker, relaxed });
        if (v.level === "fail") { failures.push({ where, why: v.why }); clean = false; }
        if (v.level === "warn") warnings.push({ where, why: v.why });
        log(`  ${v.level === "ok" ? "✓" : v.level === "warn" ? "⚠" : "✗"} ${where}  "${turn.text}" → ${reply ? `"${reply.text.slice(0, 70)}"` : "(nothing)"}`);
      }
      if (clean) scriptsOk++;
    }
  } catch (err) {
    failures.push({ where: "setup", why: err.message });
  }
  return { failures, warnings, turnsRun, scriptsOk, scripts: config.scripts.length };
}

async function main() {
  try { process.loadEnvFile(); } catch {} // .env in the cwd, if there is one
  const baseUrl = process.env.BASE_URL || "";
  if (!baseUrl) { console.error("✗ golden: BASE_URL is required."); process.exit(2); }
  const cfgPath = process.env.GOLDEN_CONFIG || fileURLToPath(new URL("./golden.config.json", import.meta.url));
  const config = JSON.parse(readFileSync(cfgPath, "utf8"));
  const relaxed = process.env.GOLDEN_RELAXED === "1";
  console.log(`▶ golden: ${baseUrl}${relaxed ? " (RELAXED)" : ""}`);
  const t0 = Date.now();
  const r = await runGolden({
    baseUrl, config, relaxed, log: console.log,
    appSecret: process.env.APP_SECRET || "", auth: process.env.GOLDEN_AUTH || "",
    timeoutMs: Number(process.env.GOLDEN_TIMEOUT_MS) || 25000, pollMs: Number(process.env.GOLDEN_POLL_MS) || 500,
  });
  const ms = Date.now() - t0;
  console.log("");
  for (const w of r.warnings) console.warn(`  ⚠ [${w.where}] ${w.why}`);
  if (r.failures.length) {
    console.error(`✗ golden FAILED: ${r.failures.length} failure(s) across ${r.scripts} scripts / ${r.turnsRun} turns (${ms}ms). Promote BLOCKED.`);
    for (const f of r.failures) console.error(`   [${f.where}] ${f.why}`);
    process.exit(1);
  }
  console.log(`✓ golden OK: ${r.scriptsOk}/${r.scripts} scripts clean, ${r.turnsRun} replies (${ms}ms).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
