// The answer rule, enforced in code on the owner's server.
//
// A caller may ask "is the owner free in these exact windows?". The answer is yes or no per
// window, nothing else: no event titles, no reasons, no busy blocks. Every window answered
// costs one unit of a disclosure budget, per calling site and in total per day, so no caller
// (honest or lying about who it is) can map the whole calendar by asking many questions.
// In "helpful" mode the owner also lets the page offer up to two nearby free windows, which
// cost budget too: this is the "lift the answer rule" knob from our study of agent networks.

import { busyIntervals, zonedParts, zonedToUtc } from "./calendar.mjs";

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export const DEFAULT_BUDGET = {
  max_windows_per_question: 6,
  per_caller_per_day: 18,      // each verified page (signed assertion), unless the owner grants more
  total_per_day: 60,           // all verified pages together
  per_ip_per_day: 12,          // unverified askers, per network address
  anonymous_total_per_day: 24, // all unverified askers together
  per_week_total: 40,          // answers about any one calendar week, all askers except trusted pages
  horizon_days: 21,
  min_minutes: 15,
  max_minutes: 120,
};

function hm(s) {
  const [h, m] = String(s).split(":").map(Number);
  return h * 60 + (m || 0);
}

export function budgetOf(profile) {
  return { ...DEFAULT_BUDGET, ...(profile.budget || {}) };
}

/**
 * Format an instant in the owner's time zone, for answers ("Tue 25 Nov 10:00").
 */
export function localLabel(ts, timeZone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(ts));
}

/**
 * Busy intervals the owner's page knows about: calendar events (with buffer) plus
 * meeting requests the owner accepted.
 */
export function blockedIntervals(profile, events, accepted, from, to) {
  const buffer = (profile.buffer_minutes || 0) * MIN;
  const busy = busyIntervals(events, from - DAY, to + DAY).map(([s, e]) => [s - buffer, e + buffer]);
  for (const r of accepted || []) busy.push([Date.parse(r.start) - buffer, Date.parse(r.end) + buffer]);
  return busy.sort((a, b) => a[0] - b[0]);
}

function meetingsOnDay(profile, events, accepted, dayStart) {
  const busy = busyIntervals(events, dayStart, dayStart + DAY).filter(([s]) => s >= dayStart && s < dayStart + DAY);
  const extra = (accepted || []).filter((r) => { const s = Date.parse(r.start); return s >= dayStart && s < dayStart + DAY; });
  return busy.length + extra.length;
}

/**
 * Is the owner free for the whole window? Checks working hours, protected blocks, the
 * daily meeting cap and busy time. Returns a boolean only: the reason never leaves.
 */
export function isFree(profile, events, accepted, start, end) {
  const tz = profile.timezone || "UTC";
  const a = zonedParts(start, tz);
  const b = zonedParts(end - 1, tz);
  if (a.y !== b.y || a.mo !== b.mo || a.d !== b.d) return false; // spans local midnight
  const dayKey = DAY_KEYS[a.dow];
  const hours = (profile.working_hours || {})[dayKey];
  if (!hours) return false;
  const sMin = a.h * 60 + a.mi;
  const eMin = sMin + Math.round((end - start) / MIN);
  if (sMin < hm(hours[0]) || eMin > hm(hours[1])) return false;
  for (const p of profile.protected || []) {
    if (!(p.days || []).includes(dayKey)) continue;
    if (sMin < hm(p.to) && eMin > hm(p.from)) return false;
  }
  const dayStart = zonedToUtc(a.y, a.mo, a.d, 0, 0, tz);
  if (profile.max_meetings_per_day && meetingsOnDay(profile, events, accepted, dayStart) >= profile.max_meetings_per_day) return false;
  for (const [s, e] of blockedIntervals(profile, events, accepted, start, end)) {
    if (s < end && e > start) return false;
  }
  return true;
}

/**
 * Validate the windows a caller asks about. Returns {windows} or {reason}.
 */
export function validateWindows(profile, raw, now) {
  const budget = budgetOf(profile);
  if (!Array.isArray(raw) || raw.length === 0) return { reason: "Ask about at least one window, with start and end times." };
  if (raw.length > budget.max_windows_per_question) {
    return { reason: `Ask about at most ${budget.max_windows_per_question} windows at a time.` };
  }
  const windows = [];
  for (const w of raw) {
    const start = Date.parse(w?.start);
    const end = Date.parse(w?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { reason: "Each window needs ISO 8601 start and end times, such as 2026-11-25T10:00:00Z." };
    const minutes = (end - start) / MIN;
    if (minutes < budget.min_minutes || minutes > budget.max_minutes) {
      return { reason: `Each window must be between ${budget.min_minutes} and ${budget.max_minutes} minutes long.` };
    }
    if (start % (15 * MIN) !== 0 || end % (15 * MIN) !== 0) return { reason: "Windows must start and end on a quarter hour." };
    if (start < now) return { reason: "That window has already started. Ask about future times." };
    if (start > now + budget.horizon_days * DAY) return { reason: `Ask about times within the next ${budget.horizon_days} days.` };
    windows.push({ start, end });
  }
  const keys = new Set(windows.map((w) => `${w.start}-${w.end}`));
  if (keys.size !== windows.length) return { reason: "The same window was asked twice." };
  return { windows };
}

/**
 * Nearby free windows of the same length, on the days asked about, for helpful mode.
 */
export function suggest(profile, events, accepted, windows, limit, now) {
  if (limit <= 0) return [];
  const tz = profile.timezone || "UTC";
  const len = windows[0].end - windows[0].start;
  const asked = new Set(windows.map((w) => w.start));
  const days = [...new Set(windows.map((w) => { const p = zonedParts(w.start, tz); return zonedToUtc(p.y, p.mo, p.d, 0, 0, tz); }))];
  const found = [];
  for (const day of days) {
    const ref = windows.find((w) => w.start >= day && w.start < day + DAY)?.start ?? day;
    const candidates = [];
    for (let s = day; s < day + DAY; s += 30 * MIN) {
      if (s < now || asked.has(s)) continue;
      if (isFree(profile, events, accepted, s, s + len)) candidates.push(s);
    }
    candidates.sort((x, y) => Math.abs(x - ref) - Math.abs(y - ref));
    for (const s of candidates.slice(0, limit)) found.push({ start: s, end: s + len });
  }
  found.sort((x, y) => x.start - y.start);
  return found.slice(0, limit);
}

/**
 * Answer one availability question within the disclosure budget.
 *
 * :param ctx: {profile, events, state, callerOrigin, verifiedPage, ip, purpose, now}
 * :return: {result, receipt} where result is what the caller gets.
 */
export function answerQuestion(ctx, rawWindows) {
  const { profile, events, state, now } = ctx;
  const callerOrigin = ctx.callerOrigin || "unknown";
  const budget = budgetOf(profile);
  const name = profile.name;
  const checked = validateWindows(profile, rawWindows, now);
  if (checked.reason) return { result: { ok: false, reason: checked.reason } };
  const { windows } = checked;
  const since = now - DAY;
  const recent = (state.receipts || []).filter((r) => r.at >= since);
  // Verified pages (signed assertions, see grants.mjs) each have their own bucket and share
  // the pages' total; the owner can grant a page more or block it. Unverified askers share a
  // small anonymous pool, held per network address, that cannot touch the pages' budget.
  const page = ctx.verifiedPage || null;
  const grant = page ? (state.grants || {})[page] : null;
  if (grant?.blocked) {
    return { receipt: { at: now, caller: page, page, verified: true, ip: ctx.ip, purpose: ctx.purpose || "", asked: windows.map(iso), answers: [], suggestions: [], cost: 0, refused: true },
      result: { ok: false, reason: `${name} has not given this page access to availability. Ask ${name} directly.` } };
  }
  const sum = (rs) => rs.reduce((n, r) => n + r.cost, 0);
  let leftCaller, leftTotal;
  if (page) {
    leftCaller = (grant?.per_day ?? budget.per_caller_per_day) - sum(recent.filter((r) => r.page === page));
    leftTotal = budget.total_per_day - sum(recent.filter((r) => r.page));
  } else {
    leftCaller = budget.per_ip_per_day - sum(recent.filter((r) => !r.page && r.ip === (ctx.ip || "")));
    leftTotal = budget.anonymous_total_per_day - sum(recent.filter((r) => !r.page));
  }
  let left = Math.min(leftCaller, leftTotal);
  // However many days or pages a prober uses, it learns at most per_week_total answers about
  // any one week (half of a 9-to-5 week in half hours). Pages the owner trusts are exempt.
  const trusted = !!grant?.trusted;
  let weekNote = "";
  if (!trusted) {
    const wk = (ts) => { const d = new Date(ts); const day = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day); };
    const used = new Map();
    for (const r of (state.receipts || []).filter((x) => x.at >= now - 35 * DAY && !x.trusted)) {
      for (const w of [...(r.asked || []).filter((_, i) => r.answers?.[i] !== undefined), ...(r.suggestions || [])]) {
        const k = wk(Date.parse(w.start)); used.set(k, (used.get(k) || 0) + 1);
      }
    }
    const want = new Map();
    for (const w of windows) { const k = wk(w.start); want.set(k, (want.get(k) || 0) + 1); }
    for (const [k, n] of want) {
      const room = budget.per_week_total - (used.get(k) || 0);
      if (n > room) { left = Math.min(left, Math.max(0, room)); weekNote = " about that week"; }
    }
  }
  if (windows.length > left) {
    const receipt = { at: now, caller: page || callerOrigin, page, verified: !!page, ip: ctx.ip || "", purpose: ctx.purpose || "", asked: windows.map(iso), answers: [], suggestions: [], cost: 0, refused: true };
    return {
      receipt,
      result: {
        ok: false,
        reason: left <= 0
          ? weekNote ? `${name}'s page has answered as many questions about that week as it will. Ask ${name} directly, or ask about another week.`
            : `${name}'s page has answered as many availability questions as it will today${page ? " for this page" : " without a verified page"}. Ask ${name} directly, or try again tomorrow.`
          : `${name}'s page can answer only ${left} more window${left === 1 ? "" : "s"}${weekNote || " today"}${page && !weekNote ? " for this page" : ""}. Ask about fewer windows.`,
        budget_left: Math.max(0, left),
      },
    };
  }
  const accepted = (state.requests || []).filter((r) => r.status === "accepted");
  const answers = windows.map((w) => ({ start: iso(w).start, end: iso(w).end, local: localLabel(w.start, profile.timezone), available: isFree(profile, events, accepted, w.start, w.end) }));
  const mode = profile.answer_mode === "helpful" ? "helpful" : "strict";
  let suggestions = [];
  if (mode === "helpful" && !answers.some((a) => a.available)) {
    suggestions = suggest(profile, events, accepted, windows, Math.min(2, left - windows.length), now)
      .map((w) => ({ ...iso(w), local: localLabel(w.start, profile.timezone) }));
  }
  const cost = windows.length + suggestions.length;
  const receipt = {
    at: now, caller: page || callerOrigin, page, verified: !!page, trusted, ip: ctx.ip || "", purpose: String(ctx.purpose || "").slice(0, 160),
    asked: windows.map(iso), answers: answers.map((a) => a.available), suggestions: suggestions.map(({ start, end }) => ({ start, end })), cost, refused: false,
  };
  return {
    receipt,
    result: {
      ok: true,
      owner: name,
      owner_timezone: profile.timezone,
      answer_mode: mode,
      answers,
      suggestions,
      budget_left: left - cost,
      note: mode === "helpful"
        ? `Yes or no for each window asked. When none was free, ${name}'s page may offer up to two nearby free windows. ${name}'s calendar itself is never shared.`
        : `Yes or no for each window asked, nothing more. ${name}'s calendar is never shared.`,
    },
  };
}

function iso(w) {
  return { start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() };
}

/**
 * Free windows for the owner's own assistant (only with the owner key).
 */
export function ownerFreeWindows(profile, events, state, from, to, minutes, now) {
  // Merged free blocks in which a meeting of `minutes` fits, starting on the half hour.
  const accepted = (state.requests || []).filter((r) => r.status === "accepted");
  const len = minutes * MIN;
  const step = 30 * MIN;
  const blocks = [];
  let cur = null;
  for (let s = Math.ceil(Math.max(from, now) / step) * step; s + len <= to; s += step) {
    if (isFree(profile, events, accepted, s, s + len)) {
      if (cur && s <= cur.end) cur.end = s + len;
      else { cur = { start: s, end: s + len }; blocks.push(cur); }
    }
  }
  return blocks.slice(0, 30).map((b) => ({
    start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString(),
    local: `${localLabel(b.start, profile.timezone)}–${localLabel(b.end, profile.timezone).slice(-5)}`,
  }));
}
