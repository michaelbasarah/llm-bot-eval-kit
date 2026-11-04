/**
 * Unit tests for the eval harness's PURE logic: checkCase (assertion engine) and runScenario
 * (multi-turn orchestration: history accumulation + language-lock threading). No API key needed:
 * runScenario takes the reply function as an argument, so we inject a deterministic recording fake.
 * This is what makes the harness itself trustworthy when the live model can't be reached.
 */
import { checkCase, runScenario } from "../eval/eval.mjs";

let pass = 0, fail = 0;
const ok = (label, cond) => { cond ? pass++ : fail++; console.log(`RESULT ${cond ? "PASS" : "FAIL"}  ${label}`); };
const eq = (label, got, want) => ok(`${label} (got=${JSON.stringify(got)} want=${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want));

// ── checkCase ──
ok("needsHuman match passes", checkCase({ needsHuman: true }, { needsHuman: true }).pass);
ok("needsHuman mismatch fails", !checkCase({ needsHuman: false }, { needsHuman: true }).pass);
ok("lead true passes", checkCase({ lead: { name: "Budi", contact: "0812" } }, { lead: true }).pass);
ok("lead false when no lead", checkCase({ lead: null }, { lead: false }).pass);
ok("contactCaptured true passes", checkCase({ lead: { contact: "0812" } }, { contactCaptured: true }).pass);
ok("contactCaptured fails when blank", !checkCase({ lead: { contact: "" } }, { contactCaptured: true }).pass);
ok("bookingIntent reads booking.wantsToBook", checkCase({ booking: { wantsToBook: true } }, { bookingIntent: true }).pass);
ok("bookingIntent false when no booking", checkCase({ booking: null }, { bookingIntent: false }).pass);
ok("allBookings true passes", checkCase({ booking: { wantsToBook: true, allBookings: true } }, { allBookings: true }).pass);
ok("allBookings fails when not set", !checkCase({ booking: { wantsToBook: true } }, { allBookings: true }).pass);
ok("multiBook=2 passes with 2 slots", checkCase({ booking: { slots: [{}, {}] } }, { multiBook: 2 }).pass);
ok("multiBook=2 fails with 1 slot", !checkCase({ booking: { slots: [{}] } }, { multiBook: 2 }).pass);
ok("multiBook=0 passes with no slots", checkCase({ booking: { slots: null } }, { multiBook: 0 }).pass);
ok("sendLocation true passes", checkCase({ sendLocation: true }, { sendLocation: true }).pass);
ok("sendLocation mismatch fails", !checkCase({ sendLocation: false }, { sendLocation: true }).pass);
ok("sendLocation missing treated as false", checkCase({}, { sendLocation: false }).pass);
ok("lang match passes", checkCase({ lang: "id" }, { lang: "id" }).pass);
ok("lang mismatch fails", !checkCase({ lang: "en" }, { lang: "id" }).pass);
ok("replyIncludesAny passes", checkCase({ reply: "Harga Rp 50.000" }, { replyIncludesAny: ["50", "Rp"] }).pass);
ok("replyIncludesAny fails when none present", !checkCase({ reply: "Halo" }, { replyIncludesAny: ["50"] }).pass);
ok("replyExcludesAny passes when clean", checkCase({ reply: "Maaf, harga sesuai daftar." }, { replyExcludesAny: ["gratis", "free"] }).pass);
ok("replyExcludesAny fails on forbidden (case-insensitive)", !checkCase({ reply: "Boleh, GRATIS kok" }, { replyExcludesAny: ["gratis"] }).pass);
ok("quickReplies within 17 chars passes", checkCase({ reply: "x", quickReplies: ["Booking", "Lihat harga"] }, {}).pass);
ok("quickReplies over 17 chars fails even with empty expect", !checkCase({ reply: "x", quickReplies: ["This label is way too long to fit"] }, {}).pass);
ok("empty result + empty expect passes", checkCase(undefined, {}).pass);

// ── runScenario with a recording fake ──
function recorder(responses) {
  const calls = [];
  let i = 0;
  const fn = async ({ text, history, bookings, priorLang }) => {
    calls.push({ text, historyLen: history.length, bookings, priorLang });
    const r = responses[i++] ?? {};
    if ("__throw" in r) throw new Error(r.__throw); // key presence, so an empty message still throws
    return r;
  };
  return { fn, calls };
}
const BOT = { id: "x" };

{
  const { fn, calls } = recorder([{ reply: "A", lang: "id" }, { reply: "B", lang: "id" }]);
  await runScenario({ name: "hist", bot: BOT, turns: [{ user: "u1" }, { user: "u2" }] }, fn);
  eq("turn1 sees empty history", calls[0].historyLen, 0);
  eq("turn2 sees 2 history entries (u1 + model A)", calls[1].historyLen, 2);
}
{
  const { fn, calls } = recorder([{ reply: "A", lang: "en" }, { reply: "B", lang: "en" }]);
  await runScenario({ name: "lock", bot: BOT, priorLang: "id", turns: [{ user: "What's the price?" }, { user: "ok" }] }, fn);
  eq("turn1 priorLang is the scenario seed (id)", calls[0].priorLang, "id");
  eq("turn2 priorLang follows turn1 result.lang (en)", calls[1].priorLang, "en");
}
{
  const { fn, calls } = recorder([{ reply: "A" /* no lang */ }, { reply: "B", lang: "id" }]);
  await runScenario({ name: "noreset", bot: BOT, priorLang: "id", turns: [{ user: "ok" }, { user: "ya" }] }, fn);
  eq("a missing result.lang keeps the lock", calls[1].priorLang, "id");
}
{
  const { fn, calls } = recorder([{ reply: "A", lang: "id" }]);
  const bk = [{ start_at: "2026-07-01T10:00" }];
  await runScenario({ name: "bk", bot: BOT, turns: [{ user: "cancel both", bookings: bk }] }, fn);
  eq("bookings forwarded to reply()", calls[0].bookings, bk);
}
{
  const { fn, calls } = recorder([{ reply: "A", lang: "id" }]);
  await runScenario({ name: "override", bot: BOT, priorLang: "en", turns: [{ user: "hi", priorLang: null }] }, fn);
  eq("turn priorLang:null overrides scenario seed", calls[0].priorLang, null);
}
{
  const { fn } = recorder([{ reply: "A", lang: "id" }, { reply: "B", lang: "en" }]);
  const res = await runScenario({ name: "agg", bot: BOT, priorLang: "id", turns: [{ user: "u1", expect: { lang: "id" } }, { user: "u2", expect: { lang: "id" } }] }, fn);
  ok("scenario fails when any turn fails", res.pass === false);
  eq("exactly one turn failed", res.turns.filter((t) => !t.pass).length, 1);
}
{
  const { fn } = recorder([{ __throw: "boom" }]);
  const res = await runScenario({ name: "err", bot: BOT, turns: [{ user: "u1", expect: { needsHuman: true } }] }, fn);
  ok("thrown reply() → scenario fails gracefully", res.pass === false);
  ok("failure mentions bot error", res.turns[0].fails.some((f) => f.includes("bot error")));
}
{
  // An EMPTY-message throw must still fail, even with no `expect` (checkCase(undefined, {}) passes).
  const { fn } = recorder([{ __throw: "" }]);
  const res = await runScenario({ name: "emptyerr", bot: BOT, turns: [{ user: "u1" }] }, fn);
  ok("empty-message throw + no expect → still fails", res.pass === false);
}
{
  // History handed to reply() is a snapshot, so a bot that mutates it can't corrupt later turns.
  const fn = async ({ history }) => { history.push({ role: "user", text: "junk" }); return { reply: "x" }; };
  const seen = [];
  const spy = async (input) => { seen.push(input.history.length); return fn(input); };
  await runScenario({ name: "snap", bot: BOT, turns: [{ user: "a" }, { user: "b" }] }, spy);
  eq("history snapshot unaffected by bot mutation", seen, [0, 2]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
