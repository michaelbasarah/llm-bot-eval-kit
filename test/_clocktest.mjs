/** clock-shift: live clock reads move forward, date literals don't, Date stays a real Date. */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const ok = (label, cond) => { cond ? pass++ : fail++; console.log(`RESULT ${cond ? "PASS" : "FAIL"}  ${label}`); };

const shift = fileURLToPath(new URL("../gates/clock-shift.mjs", import.meta.url));
const probe = fileURLToPath(new URL("./fixtures/clock-probe.mjs", import.meta.url));
const DAY = 86_400_000;

// Real wall clock via performance, which clock-shift doesn't touch, so this test also holds
// when it is itself run under `npm run test:future`.
const before = performance.timeOrigin + performance.now();
const out = JSON.parse(execFileSync(process.execPath, [shift, "183", probe], { encoding: "utf8" }));
const drift = (out.now - before) / DAY;

ok(`Date.now() is ~183 days ahead (${drift.toFixed(2)})`, drift > 182.9 && drift < 183.1);
ok("new Date() is shifted too", Math.abs(out.newDate - out.now) < 5000);
ok("bare Date() still returns a string", out.bare === "string");
ok("date literals are untouched", out.literal === "2026-07-01T00:00:00.000Z");
ok("instanceof Date still true", out.isDate === true);
ok("target sees itself as argv[1]", out.argv1 === probe);

let usage = false;
try { execFileSync(process.execPath, [shift], { stdio: "pipe" }); } catch (e) { usage = String(e.stderr).includes("Usage"); }
ok("missing args → usage + non-zero exit", usage);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
