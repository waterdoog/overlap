// How much of one person's week can a determined prober learn?
//
//   node eval/adversary.mjs
//
// The prober controls K signed pages (cheap to make) and comes back every day for D days,
// asking 6-window questions about one target working week (80 half-hour slots) until refused.
// Uses the real policy code. Compared: free/busy sharing (everything at once), Overlap without
// the weekly cap, and Overlap as shipped (weekly cap 40).
import { answerQuestion } from "../core/policy.mjs";

const NOW = Date.parse("2026-11-16T00:00:00Z");
const WEEK = Date.parse("2026-11-23T00:00:00Z");
const slots = [];
for (let d = 0; d < 5; d++) for (let h = 9; h < 17; h++) for (const m of [0, 30]) slots.push(WEEK + d * 86400000 + h * 3600000 + m * 60000);
const profile = { name: "Bo", timezone: "UTC", working_hours: Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, ["09:00", "17:00"]])), protected: [], buffer_minutes: 0 };

function probe({ pages, days, weekCap }) {
  const p = { ...profile, budget: { per_week_total: weekCap ?? 1e9 } };
  const state = { receipts: [], requests: [] };
  const learned = new Set();
  const out = [];
  for (let day = 0; day < days; day++) {
    for (let k = 0; k < pages; k++) {
      for (;;) {
        const ask = slots.filter((s) => !learned.has(s)).slice(0, 6);
        if (!ask.length) break;
        const r = answerQuestion({ profile: p, events: [], state, callerOrigin: `https://sybil${k}.example`, verifiedPage: `https://sybil${k}.example`, now: NOW + day * 86400000 + k * 1000 }, ask.map((s) => ({ start: new Date(s).toISOString(), end: new Date(s + 1800000).toISOString() })));
        if (r.receipt) state.receipts.push(r.receipt);
        if (!r.result.ok) break;
        for (const a of r.result.answers) learned.add(Date.parse(a.start));
      }
    }
    out.push(learned.size);
  }
  return out;
}

const pct = (n) => `${Math.round((100 * n) / slots.length)}%`;
console.log("Share of one target week (80 half-hour slots) a prober learns, by day");
console.log("setting                                   day1  day2  day3  day7");
const row = (label, xs) => console.log(`${label.padEnd(42)}${[0, 1, 2, 6].map((i) => pct(xs[i]).padStart(6)).join("")}`);
row("free/busy sharing", [80, 80, 80, 80, 80, 80, 80]);
row("Overlap, 1 signed page, no weekly cap", probe({ pages: 1, days: 7 }));
row("Overlap, 10 signed pages, no weekly cap", probe({ pages: 10, days: 7 }));
row("Overlap as shipped, 1 signed page", probe({ pages: 1, days: 7, weekCap: 40 }));
row("Overlap as shipped, 10 signed pages", probe({ pages: 10, days: 7, weekCap: 40 }));

console.log("\nThe weekly cap is a dial: what a 10-page prober learns of one week, by cap (any number of days)");
console.log("cap   learned");
for (const cap of [12, 24, 40, 60, 80]) {
  const xs = probe({ pages: 10, days: 7, weekCap: cap });
  console.log(`${String(cap).padEnd(6)}${pct(xs[6])}`);
}
console.log("A cooperative three-person search asks about 6-12 windows per person (eval/simulate.mjs), so a cap of 24-40 leaves room for 2-6 searches a week.");
