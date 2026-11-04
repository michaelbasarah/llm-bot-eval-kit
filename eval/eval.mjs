/**
 * Behaviour regression + guardrail suite for an LLM chatbot.
 *
 * Runs persona scenarios (multi-turn conversations) through a bot's reply() and asserts the
 * STRUCTURED output behaves: questions answered from the business info, leads captured on real
 * intent, booking intent + multi-slot + cancel-all detected, medical questions handed off, the
 * conversation language lock held (no flip on a short/ambiguous turn; DO switch when the customer
 * clearly writes another language), quick-reply labels within WhatsApp's 17-char limit, and prompt
 * injection refused.
 *
 * Why: once a bot is live, the risk shifts from "does it crash" to "did a prompt or code change
 * SILENTLY DRIFT its behaviour". Run this before promoting a change.
 *
 *   npm run eval                            # toy bot; live if GEMINI_API_KEY is set, else fake mode
 *   npm run eval -- --bot ./my-bot.mjs      # your bot: a module exporting reply()
 *   npm run eval -- --only language         # scenarios whose name contains "language"
 *
 * The harness logic is pure and unit-tested in test/_evaltest.mjs:
 *   - checkCase()   assertion engine (one result vs one expectation)
 *   - runScenario() multi-turn orchestration; it takes reply() as an argument, so the test injects
 *                   a deterministic fake while the CLI injects the real bot.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { SCENARIOS } from "./scenarios.mjs";

export { SCENARIOS };

const QR_MAX = 17; // WhatsApp button/list label hard limit (chars incl. spaces)

/**
 * Given a bot result and an expectation, return { pass, fails }.
 *   needsHuman / lead / bookingIntent / allBookings / sendLocation   boolean match
 *   contactCaptured   a non-empty lead.contact was captured
 *   multiBook         booking.slots has exactly N entries
 *   lang              result.lang equals the expected language code
 *   replyIncludesAny  reply contains at least one of the substrings (case-insensitive)
 *   replyExcludesAny  reply contains NONE of the substrings (case-insensitive)
 * Always enforced, whatever `expect` says: every quickReply label is ≤ QR_MAX chars.
 */
export function checkCase(result, expect = {}) {
  const fails = [];
  const reply = String(result?.reply ?? "").toLowerCase();
  const has = (s) => reply.includes(String(s).toLowerCase());
  const bool = (key, got) => {
    if (key in expect && Boolean(got) !== expect[key]) fails.push(`${key}: got ${Boolean(got)}, want ${expect[key]}`);
  };

  bool("needsHuman", result?.needsHuman);
  bool("lead", result?.lead);
  bool("contactCaptured", result?.lead?.contact);
  bool("bookingIntent", result?.booking?.wantsToBook);
  bool("allBookings", result?.booking?.allBookings);
  bool("sendLocation", result?.sendLocation);
  if ("multiBook" in expect) {
    const n = Array.isArray(result?.booking?.slots) ? result.booking.slots.length : 0;
    if (n !== expect.multiBook) fails.push(`multiBook: got ${n} slot(s), want ${expect.multiBook}`);
  }
  if ("lang" in expect && result?.lang !== expect.lang) {
    fails.push(`lang: got ${result?.lang ?? "(none)"}, want ${expect.lang}`);
  }
  if (expect.replyIncludesAny && !expect.replyIncludesAny.some(has)) {
    fails.push(`reply missing any of [${expect.replyIncludesAny.join(", ")}]`);
  }
  if (expect.replyExcludesAny) {
    const hit = expect.replyExcludesAny.filter(has);
    if (hit.length) fails.push(`reply contains forbidden [${hit.join(", ")}]`);
  }
  if (Array.isArray(result?.quickReplies)) {
    const tooLong = result.quickReplies.filter((q) => String(q ?? "").length > QR_MAX);
    if (tooLong.length) fails.push(`quickReplies over ${QR_MAX} chars: [${tooLong.join(", ")}]`);
  }
  return { pass: fails.length === 0, fails };
}

/**
 * Run one scenario's turns in order, threading conversation state the way a real server would:
 *   - history accumulates {role:"user"} then {role:"model"} after each turn (oldest first);
 *   - the language lock starts at scenario.priorLang and, after each turn, advances to result.lang
 *     ONLY when that's truthy (a missing lang never resets an established lock);
 *   - a turn may override `bookings` (existing bookings, for cancel) and `priorLang`.
 * `replyFn({ text, bot, history, priorLang, bookings })` is injected. Returns one entry per turn.
 */
export async function runScenario(scenario, replyFn) {
  const history = [];
  let priorLang = scenario.priorLang ?? null;
  const turns = [];
  for (const turn of scenario.turns) {
    const bookings = turn.bookings ?? scenario.bookings ?? [];
    const lang = "priorLang" in turn ? turn.priorLang : priorLang;
    let result, threw = false, error = "";
    try {
      result = await replyFn({ text: turn.user, bot: scenario.bot, history: [...history], priorLang: lang, bookings });
    } catch (err) {
      // Track the throw with a flag, not the message's truthiness: an Error with an empty message
      // must still fail the turn, not slip into the assertion path.
      threw = true;
      error = err?.message || String(err) || "unknown error";
    }
    const check = threw ? { pass: false, fails: [`bot error: ${error.slice(0, 100)}`] } : checkCase(result, turn.expect ?? {});
    turns.push({ user: turn.user, result, ...check });
    history.push({ role: "user", text: turn.user });
    history.push({ role: "model", text: String(result?.reply ?? "") });
    if (result?.lang) priorLang = result.lang;
  }
  return { name: scenario.name, pass: turns.every((t) => t.pass), turns };
}

/** Run every scenario, print a report, return { passed, total }. */
export async function runAll(replyFn, { scenarios = SCENARIOS, log = console.log } = {}) {
  let passed = 0;
  for (const scenario of scenarios) {
    const res = await runScenario(scenario, replyFn);
    if (res.pass) {
      passed++;
      log(`✓ ${res.name}`);
      continue;
    }
    log(`✗ ${res.name}`);
    for (const t of res.turns.filter((x) => !x.pass)) {
      log(`    turn "${t.user.slice(0, 60)}"`);
      log(`      ${t.fails.join("\n      ")}`);
      log(`      reply: ${String(t.result?.reply ?? "").slice(0, 120)}`);
    }
  }
  log(`\n${passed}/${scenarios.length} scenarios passed.`);
  return { passed, total: scenarios.length };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  try { process.loadEnvFile(); } catch {} // .env in the cwd, if there is one
  const botPath = arg("bot");
  const only = arg("only")?.toLowerCase();
  let replyFn, label;
  if (botPath) {
    ({ reply: replyFn } = await import(pathToFileURL(resolve(botPath)).href));
    if (typeof replyFn !== "function") throw new Error(`${botPath} must export a reply() function`);
    label = botPath;
  } else {
    const toy = await import("../bot/toybot.mjs");
    replyFn = toy.reply;
    label = `toy bot, ${toy.mode()} mode${toy.mode() === "fake" ? " (no GEMINI_API_KEY)" : ""}`;
  }
  const scenarios = only ? SCENARIOS.filter((s) => s.name.toLowerCase().includes(only)) : SCENARIOS;
  console.log(`▶ eval: ${label}, ${scenarios.length} scenarios\n`);
  const { passed, total } = await runAll(replyFn, { scenarios });
  if (passed < total) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
