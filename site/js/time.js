// Time-zone helpers for the browser (same maths as core/calendar.mjs on the server).
export function tzOffset(ts, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}

export function zonedParts(ts, timeZone) {
  const d = new Date(ts + tzOffset(ts, timeZone));
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() };
}

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const hm = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + (m || 0); };

/** Is [start, end) inside a person's usual hours (their own time zone)? */
export function withinHours(hours, timeZone, start, end) {
  if (!hours) return true; // unknown hours: let their page decide
  const a = zonedParts(start, timeZone);
  const b = zonedParts(end - 1, timeZone);
  if (a.d !== b.d) return false;
  const h = hours[DAY_KEYS[a.dow]];
  if (!h) return false;
  const s = a.h * 60 + a.mi;
  const e = s + Math.round((end - start) / 60000);
  return s >= hm(h[0]) && e <= hm(h[1]);
}

export function label(ts, timeZone, withDay = true) {
  const opts = withDay
    ? { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }
    : { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone };
  return new Intl.DateTimeFormat("en-GB", opts).format(new Date(ts));
}
