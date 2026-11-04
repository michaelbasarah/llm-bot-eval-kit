// Prints what the clock looks like from inside a script; used by _clocktest.mjs.
console.log(JSON.stringify({
  now: Date.now(),
  newDate: new Date().getTime(),
  bare: typeof Date(),
  literal: new Date("2026-07-01T00:00:00Z").toISOString(),
  isDate: new Date() instanceof Date,
  argv1: process.argv[1],
}));
