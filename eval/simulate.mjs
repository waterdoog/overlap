// How much does a meeting search cost in disclosure, and does lifting the answer rule help?
//
//   node eval/simulate.mjs [--n 1000] [--seed 7]
//
// Deterministic simulation with the real policy code (core/policy.mjs), no model.
// Each scenario: an organiser and 2 other people in random time zones, each with a random
// working week calendar (busy share 35-65%). The organiser's page picks candidate windows
// the way Overlap's candidate_windows does (inside its own free time and everyone's usual
// hours, round-robin over days, 6 per question) and asks each person's page once per round.
// Three policies for the other people's pages:
//   strict   yes/no per asked window (the answer rule)
//   helpful  yes/no, plus up to 2 nearby free windows when none asked is free
//   freebusy the page hands over its whole free/busy week (what calendar sharing does today)
// Measures: success (a 30-minute window all three are free, found within the budget of
// 18 windows per site per day), rounds, and how many slots of each person's week a caller
// learned (a 30-minute slot learned = one bit about one half hour).
import { answerQuestion, isFree } from "../core/policy.mjs";
import { zonedToUtc } from "../core/calendar.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const N = arg("--n", 1000);
let seed = arg("--seed", 7);
const BUSY_LO = arg("--busy-lo", 0.35), BUSY_HI = arg("--busy-hi", 0.65);
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-22T00:00:00Z"); // a Sunday
const WEEK_START = Date.parse("2026-11-23T00:00:00Z");
const ZONES = ["Europe/London", "Europe/Stockholm", "America/New_York", "America/Toronto", "Asia/Singapore", "Europe/Berlin", "America/Los_Angeles", "Asia/Kolkata"];
const HOURS = { mon: ["09:00", "17:00"], tue: ["09:00", "17:00"], wed: ["09:00", "17:00"], thu: ["09:00", "17:00"], fri: ["09:00", "17:00"] };

function person(tz) {
  const busyShare = BUSY_LO + rnd() * (BUSY_HI - BUSY_LO);
  const events = [];
  for (let d = 0; d < 5; d++) {
    const day = new Date(WEEK_START + d * DAY);
    for (let h = 9; h < 17; h += 0.5) {
      if (rnd() < busyShare) {
        const s = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), Math.floor(h), (h % 1) * 60, tz);
        events.push({ start: s, end: s + 30 * MIN, rrule: null, exdates: [], allDay: false, tz });
      }
    }
  }
  return { profile: { name: tz, timezone: tz, working_hours: HOURS, protected: [], buffer_minutes: 0, answer_mode: "strict" }, events };
}

function candidates(org, others, asked, len) {
  const byDay = new Map();
  for (let s = WEEK_START; s < WEEK_START + 5 * DAY; s += 30 * MIN) {
    if (asked.has(s)) continue;
    if (!isFree(org.profile, org.events, [], s, s + len)) continue;
    // Other people's usual hours are public; their calendars are not.
    if (!others.every((o) => withinHours(o, s, s + len))) continue;
    const k = new Date(s).toISOString().slice(0, 10);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(s);
  }
  const out = [];
  const days = [...byDay.values()];
  for (let i = 0; out.length < 6 && days.some((d) => d.length > i); i++) for (const d of days) if (d[i] !== undefined && out.length < 6) out.push(d[i]);
  return out.sort((a, b) => a - b);
}

function withinHours(p, s, e) {
  // isFree without the calendar = inside usual hours
  return isFree({ ...p.profile, max_meetings_per_day: 0 }, [], [], s, e);
}

function run(policy, sc) {
  const [org, ...others] = sc;
  const len = 30 * MIN;
  const states = others.map(() => ({ receipts: [], requests: [] }));
  const asked = new Set();
  let preferred = [];
  for (let round = 1; round <= 5; round++) {
    if (policy === "freebusy") {
      // One round: each page hands over its whole week; the organiser intersects locally.
      for (let s = WEEK_START; s < WEEK_START + 5 * DAY; s += 30 * MIN) {
        if ([org, ...others].every((p) => isFree(p.profile, p.events, [], s, s + len))) return { ok: true, rounds: 1, learned: 80 };
      }
      return { ok: false, rounds: 1, learned: 80 };
    }
    let ws = preferred.filter((s) => !asked.has(s) && isFree(org.profile, org.events, [], s, s + len) && others.every((o) => withinHours(o, s, s + len))).slice(0, 6);
    if (ws.length < 6) ws = [...new Set([...ws, ...candidates(org, others, new Set([...asked, ...ws]), len)])].slice(0, 6);
    if (!ws.length) break;
    for (const s of ws) asked.add(s);
    preferred = [];
    const answers = others.map((o, i) => {
      const { result, receipt } = answerQuestion({ profile: { ...o.profile, answer_mode: policy }, events: o.events, state: states[i], callerOrigin: "https://org.example", verifiedPage: "https://org.example", now: NOW },
        ws.map((s) => ({ start: new Date(s).toISOString(), end: new Date(s + len).toISOString() })));
      if (receipt) states[i].receipts.push(receipt);
      return result;
    });
    if (answers.some((a) => !a.ok)) return { ok: false, rounds: round, learned: learned(states), budget: true };
    const common = ws.filter((s, k) => answers.every((a) => a.answers[k].available));
    if (common.length) return { ok: true, rounds: round, learned: learned(states) };
    for (const a of answers) for (const sug of a.suggestions) preferred.push(Date.parse(sug.start));
  }
  return { ok: false, rounds: 5, learned: learned(states) };
}

function learned(states) {
  // slots of each person's week revealed (asked windows + suggestions), averaged over people
  return states.reduce((n, s) => n + s.receipts.reduce((m, r) => m + r.cost, 0), 0) / states.length;
}

const results = { strict: [], helpful: [], freebusy: [] };
for (let i = 0; i < N; i++) {
  const zones = [pick(ZONES), pick(ZONES), pick(ZONES)];
  const sc = zones.map(person);
  // Only scenarios where a common window exists are informative.
  let exists = false;
  for (let s = WEEK_START; s < WEEK_START + 5 * DAY && !exists; s += 30 * MIN) exists = sc.every((p) => isFree(p.profile, p.events, [], s, s + 30 * MIN));
  if (!exists) continue;
  for (const pol of Object.keys(results)) results[pol].push(run(pol, sc));
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
// Wilson 95% interval for a proportion.
const wilson = (k, n) => { const z = 1.96, p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d; return `[${(100 * (c - h)).toFixed(1)}, ${(100 * Math.min(1, c + h)).toFixed(1)}]`; };
console.log(`busy share ${BUSY_LO}-${BUSY_HI}; scenarios with a common 30-minute window: ${results.strict.length} of ${N}`);
console.log("policy    found  95% CI          rounds(found)  slots learned per person (of 80 in the week)");
for (const [pol, rs] of Object.entries(results)) {
  const found = rs.filter((r) => r.ok);
  const over = rs.filter((r) => r.budget).length;
  console.log(`${pol.padEnd(9)} ${(100 * found.length / rs.length).toFixed(1).padStart(5)}% ${wilson(found.length, rs.length).padEnd(14)} ${mean(found.map((r) => r.rounds)).toFixed(2).padStart(6)}         ${mean(rs.map((r) => r.learned)).toFixed(1)}${over ? `   (${over} stopped by budget)` : ""}`);
}
