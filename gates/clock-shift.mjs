/**
 * Run one script with the process clock pushed forward, to PROVE a test suite stays green as
 * calendar time passes instead of hoping it does.
 *
 * Only the "live clock" reads move: no-arg `new Date()`, bare `Date()`, and `Date.now()`. Literal
 * dates like `new Date("2026-07-01")` are untouched, so tests that inject a fixed `now` keep their
 * exact meaning. What this catches is the date-literal time bomb: a fixture that says "July 1st"
 * and a check that assumes it's in the future. Green for months, then red on a random morning with
 * zero code change. Running the suite at +183 days in CI finds it today.
 *
 *   node gates/clock-shift.mjs <days> <script.mjs>      (npm run test:future loops every test)
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const offsetDays = Number(process.argv[2]);
const target = process.argv[3];
if (!Number.isFinite(offsetDays) || !target) {
  console.error(`Usage: node clock-shift.mjs <days> <script.mjs>\nGot: days=${process.argv[2]} target=${process.argv[3]}`);
  process.exit(1);
}
const OFFSET_MS = offsetDays * 24 * 60 * 60 * 1000;
const RealDate = Date;

// A plain function, not a class, so a bare `Date()` call (no `new`, which native Date supports and
// which returns a string) keeps working. `new.target` tells the two call forms apart.
function ShiftedDate(...args) {
  if (!new.target) return new RealDate(RealDate.now() + OFFSET_MS).toString();
  if (args.length === 0) return new RealDate(RealDate.now() + OFFSET_MS);
  return new RealDate(...args);
}
ShiftedDate.now = () => RealDate.now() + OFFSET_MS;
ShiftedDate.parse = RealDate.parse;
ShiftedDate.UTC = RealDate.UTC;
ShiftedDate.prototype = RealDate.prototype; // keeps `instanceof Date`, toISOString etc. genuine
globalThis.Date = ShiftedDate;

// Point argv[1] at the target so its own "am I the entry point?" checks still work.
process.argv.splice(1, 3, resolve(target));
await import(pathToFileURL(resolve(target)).href);
