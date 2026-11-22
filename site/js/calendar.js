// Reads an owner's calendar (iCalendar text) into busy intervals, in UTC milliseconds.
// Runs on the owner's server, or in the owner's own browser (hosted start page). Callers never
// get its output: the policy module
// turns busy intervals into yes/no answers for the exact windows asked.

const DAY = 86400000;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/**
 * Offset of a time zone from UTC at an instant, in milliseconds (local = utc + offset).
 */
export function tzOffset(ts, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/**
 * Convert a wall-clock time in a time zone to a UTC instant.
 */
export function zonedToUtc(y, mo, d, h, mi, timeZone) {
  const guess = Date.UTC(y, mo, d, h, mi);
  let ts = guess - tzOffset(guess, timeZone);
  // Second pass settles DST edges.
  ts = guess - tzOffset(ts, timeZone);
  return ts;
}

/**
 * Wall-clock parts of an instant in a time zone.
 */
export function zonedParts(ts, timeZone) {
  const local = new Date(ts + tzOffset(ts, timeZone));
  return {
    y: local.getUTCFullYear(), mo: local.getUTCMonth(), d: local.getUTCDate(),
    h: local.getUTCHours(), mi: local.getUTCMinutes(), dow: local.getUTCDay(),
  };
}

function unfold(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function parseProp(line) {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = head.split(";");
  const params = {};
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value };
}

function parseDate(value, params, defaultTz) {
  const v = value.trim();
  if (/^\d{8}$/.test(v) || params.VALUE === "DATE") {
    const y = +v.slice(0, 4), mo = +v.slice(4, 6) - 1, d = +v.slice(6, 8);
    return { allDay: true, y, mo, d, ts: zonedToUtc(y, mo, d, 0, 0, params.TZID || defaultTz) };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (z) return { allDay: false, ts: Date.UTC(+y, +mo - 1, +d, +h, +mi) };
  return { allDay: false, ts: zonedToUtc(+y, +mo - 1, +d, +h, +mi, params.TZID || defaultTz) };
}

function parseDuration(value) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return 0;
  const [, sign, w, d, h, mi, s] = m;
  const ms = ((+w || 0) * 7 * DAY) + ((+d || 0) * DAY) + ((+h || 0) * 3600000) + ((+mi || 0) * 60000) + ((+s || 0) * 1000);
  return sign === "-" ? -ms : ms;
}

function parseRrule(value) {
  const out = {};
  for (const part of value.split(";")) {
    const [k, v] = part.split("=");
    if (k && v) out[k.toUpperCase()] = v;
  }
  return out;
}

/**
 * Parse iCalendar text into events: {start, end, rrule, exdates, allDay, tz}.
 * Cancelled and "free" (TRANSP:TRANSPARENT) events are dropped: they do not block time.
 */
export function parseIcs(text, defaultTz = "UTC") {
  const events = [];
  let cur = null;
  for (const raw of unfold(text)) {
    const line = raw.trimEnd();
    if (line === "BEGIN:VEVENT") { cur = { exdates: [] }; continue; }
    if (line === "END:VEVENT") {
      if (cur && cur.start && !cur.cancelled && !cur.free) {
        if (cur.end == null) cur.end = cur.duration ? cur.start.ts + cur.duration : cur.start.ts + (cur.start.allDay ? DAY : 0);
        events.push({
          start: cur.start.ts, end: cur.end, allDay: cur.start.allDay, tz: cur.tz || defaultTz,
          wall: cur.start, rrule: cur.rrule || null, exdates: cur.exdates,
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const p = parseProp(line);
    if (!p) continue;
    if (p.name === "DTSTART") { cur.start = parseDate(p.value, p.params, defaultTz); cur.tz = p.params.TZID; }
    else if (p.name === "DTEND") { const e = parseDate(p.value, p.params, defaultTz); if (e) cur.end = e.ts; }
    else if (p.name === "DURATION") cur.duration = parseDuration(p.value);
    else if (p.name === "RRULE") cur.rrule = parseRrule(p.value);
    else if (p.name === "EXDATE") {
      for (const v of p.value.split(",")) { const e = parseDate(v, p.params, defaultTz); if (e) cur.exdates.push(e.ts); }
    }
    else if (p.name === "STATUS" && p.value.trim().toUpperCase() === "CANCELLED") cur.cancelled = true;
    else if (p.name === "TRANSP" && p.value.trim().toUpperCase() === "TRANSPARENT") cur.free = true;
  }
  return events;
}

/**
 * Expand events (with simple DAILY/WEEKLY recurrence) into busy intervals that touch
 * [from, to). Recurrences repeat the wall-clock start in the event's own time zone.
 */
export function busyIntervals(events, from, to) {
  const out = [];
  for (const ev of events) {
    const len = ev.end - ev.start;
    if (!ev.rrule) {
      if (ev.end > from && ev.start < to) out.push([ev.start, ev.end]);
      continue;
    }
    const r = ev.rrule;
    const freq = (r.FREQ || "").toUpperCase();
    if (freq !== "DAILY" && freq !== "WEEKLY") {
      if (ev.end > from && ev.start < to) out.push([ev.start, ev.end]);
      continue;
    }
    const interval = Math.max(1, +r.INTERVAL || 1);
    const count = r.COUNT ? +r.COUNT : Infinity;
    const until = r.UNTIL ? (parseDate(r.UNTIL, {}, "UTC")?.ts ?? Infinity) : Infinity;
    const byday = r.BYDAY ? r.BYDAY.split(",").map((s) => WEEKDAYS.indexOf(s.slice(-2))) : null;
    const tz = ev.tz;
    const w = zonedParts(ev.start, tz);
    const startDay = Date.UTC(w.y, w.mo, w.d);
    const weekStart = startDay - w.dow * DAY;
    let n = 0;
    for (let day = startDay; day < to + DAY && n < count; day += DAY) {
      const dd = new Date(day);
      const dow = dd.getUTCDay();
      const daysSince = Math.round((day - startDay) / DAY);
      let hit;
      if (freq === "DAILY") hit = daysSince % interval === 0;
      else {
        const weeksSince = Math.floor((day - weekStart) / (7 * DAY));
        hit = weeksSince % interval === 0 && (byday ? byday.includes(dow) : dow === w.dow);
      }
      if (!hit) continue;
      const s = ev.allDay
        ? zonedToUtc(dd.getUTCFullYear(), dd.getUTCMonth(), dd.getUTCDate(), 0, 0, tz)
        : zonedToUtc(dd.getUTCFullYear(), dd.getUTCMonth(), dd.getUTCDate(), w.h, w.mi, tz);
      if (s > until) break;
      n += 1;
      if (ev.exdates.some((x) => Math.abs(x - s) < 60000)) continue;
      if (s + len > from && s < to) out.push([s, s + len]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** Busy intervals [[startMs, endMs], ...] as an iCalendar file with no titles or details. */
export function busyToIcs(busy) {
  const t = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...busy.flatMap(([s, e], i) => ["BEGIN:VEVENT", `UID:busy-${i}`, `DTSTART:${t(s)}`, `DTEND:${t(e)}`, "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");
}
