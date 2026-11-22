// The page object for one person's Overlap page. The page's own buttons and the
// assistant's website_* tools call the same methods, so both follow one set of rules.
import { Api } from "./js/api.js";
import { label, withinHours } from "./js/time.js";

const PEOPLE_KEY = `overlap-people-v1:${new URL("./", import.meta.url).pathname}`;
// The runtime allows 4 partner calls per visitor message, so up to 4 people.
const SLOTS = ["person_1", "person_2", "person_3", "person_4"];
const MIN = 60000;

export class Page {
  constructor() {
    this.profile = null;
    this.owner = false;
    this.people = Page.loadPeople();
    this.asked = new Set(); // candidate windows already asked about in this visit
    this.listeners = new Set();
  }

  static loadPeople() {
    try { return JSON.parse(localStorage.getItem(PEOPLE_KEY) || "[]").slice(0, SLOTS.length); } catch { return []; }
  }

  savePeople() {
    try { localStorage.setItem(PEOPLE_KEY, JSON.stringify(this.people)); } catch {}
    this.emit();
  }

  onChange(fn) { this.listeners.add(fn); }
  emit() { for (const fn of this.listeners) { try { fn(); } catch (e) { console.error(e); } } }

  async init() {
    this.profile = await Api.profile();
    await this.refreshOwner();
    return this;
  }

  async refreshOwner() {
    if (!Api.ownerKey()) { this.owner = false; this.overview = null; return; }
    const ov = await Api.overview().catch(() => null);
    this.owner = !!ov?.ok;
    this.overview = this.owner ? ov : null;
    this.emit();
  }

  async signIn(key) {
    Api.setOwnerKey(key);
    await this.refreshOwner();
    if (!this.owner) { Api.setOwnerKey(""); return { ok: false, reason: "That is not this page's owner key." }; }
    return { ok: true };
  }

  signOut() { Api.setOwnerKey(""); this.owner = false; this.overview = null; this.emit(); }

  // ----- reads the assistant uses -----

  getProfile() {
    const p = this.profile;
    return {
      page_owner: { name: p.name, headline: p.headline, org: p.org, timezone: p.timezone, public_hours: p.public_hours, about: p.about, topics: p.topics },
      answer_rules: { mode: p.answer_mode, ...p.rules },
      visitor_is_owner: this.owner,
      now_utc: new Date().toISOString(),
      visitor_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      people: this.owner ? this.people.map((x) => ({ tool: x.slot, name: x.name, org: x.org, timezone: x.timezone, public_hours: x.public_hours, page: x.origin })) : [],
    };
  }

  checkWindows(args) {
    return Api.check(args, location.origin);
  }

  requestStatus(args) { return Api.status(args.reference); }

  async myFreeTime(args) {
    if (!this.owner) return { ok: false, reason: "Only the page's owner can read their own free time. Visitors can ask with check_windows." };
    const from = args.from || new Date().toISOString();
    const to = args.to || new Date(Date.parse(from) + 7 * 86400000).toISOString();
    return Api.free({ from, to, minutes: args.minutes || 30 });
  }

  /**
   * Pick up to 6 windows to ask everyone about: inside the owner's own free time and
   * inside each invited person's published usual hours, spread across days, skipping
   * windows already asked in this visit. Deterministic, so the model does no date maths.
   */
  async candidateWindows(args) {
    if (!this.owner) return { ok: false, reason: "Only the page's owner can plan meetings from this page." };
    const minutes = Math.min(120, Math.max(15, args.minutes || 30));
    const from = Date.parse(args.from) || Date.now();
    const to = Date.parse(args.to) || from + 7 * 86400000;
    const free = await Api.free({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), minutes });
    if (!free.ok) return free;
    const who = args.people?.length ? this.people.filter((p) => args.people.includes(p.slot)) : this.people;
    if (!who.length) return { ok: false, reason: "Add the people's Overlap pages under People first." };
    const len = minutes * MIN;
    const byDay = new Map();
    for (const block of free.free) {
      for (let s = Date.parse(block.start); s + len <= Date.parse(block.end); s += 30 * MIN) {
        const key = `${new Date(s).toISOString()}|${new Date(s + len).toISOString()}`;
        if (this.asked.has(key)) continue;
        if (!who.every((p) => withinHours(p.hours, p.timezone, s, s + len))) continue;
        const day = new Date(s).toISOString().slice(0, 10);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(s);
      }
    }
    // Round-robin over days, so 6 questions cover as many days as possible.
    const picks = [];
    const days = [...byDay.values()];
    for (let i = 0; picks.length < 6 && days.some((d) => d.length > i); i += 1) {
      for (const d of days) if (d[i] !== undefined && picks.length < 6) picks.push(d[i]);
    }
    picks.sort((a, b) => a - b);
    const windows = picks.map((s) => ({ start: new Date(s).toISOString(), end: new Date(s + len).toISOString() }));
    for (const w of windows) this.asked.add(`${w.start}|${w.end}`);
    const tzs = [this.profile.timezone, ...who.map((p) => p.timezone)];
    return {
      ok: true,
      minutes,
      people: who.map((p) => ({ tool: p.slot, name: p.name })),
      windows,
      labels: windows.map((w) => tzs.map((tz) => `${label(Date.parse(w.start), tz)} ${tz}`).join(" = ")),
      note: windows.length ? "Ask each person's tool about exactly these windows, then keep only those every answer marks free." : "No window fits everyone's usual hours and your free time in that range. Try a longer range or a shorter meeting.",
    };
  }

  // ----- people -----

  async addPerson(raw) {
    if (this.people.length >= SLOTS.length) return { ok: false, reason: `This page asks at most ${SLOTS.length} people at once.` };
    let url;
    try { url = new URL(String(raw).trim()); } catch { return { ok: false, reason: "Paste the address of their Overlap page, such as https://bo.example/" }; }
    const origin = url.origin;
    const base = `${origin}${url.pathname.replace(/\/[^/]*\.[a-z]+$/i, "/").replace(/\/?$/, "/")}`;
    // Pages may share an origin (hosted under /u/<id>/), so compare page addresses.
    if (base === new URL("./", import.meta.url).href) return { ok: false, reason: "That is this page." };
    if (this.people.some((p) => p.networkUrl === `${base}overlap_pass`)) return { ok: false, reason: "Already on your list." };
    let manifest, profile;
    try {
      manifest = await (await fetch(new URL("agent-manifest.json", base), { cache: "no-store" })).json();
      profile = await (await fetch(new URL("api/profile", base), { cache: "no-store" })).json();
    } catch {
      return { ok: false, reason: "Could not read that page's agent files. Check the address." };
    }
    const net = (manifest.networks || []).find((n) => n.name === "overlap_pass");
    if (!net || !profile?.ok) return { ok: false, reason: "That page does not publish an overlap_pass network." };
    const slot = SLOTS.find((s) => !this.people.some((p) => p.slot === s));
    const person = {
      slot, origin, networkUrl: `${base}overlap_pass`.replace(/(?<!:)\/\//g, "/"),
      name: profile.name, org: profile.org, timezone: profile.timezone, public_hours: profile.public_hours,
      hours: profile.hours, initials: profile.initials, color: profile.color,
    };
    this.people.push(person);
    this.savePeople();
    return { ok: true, person };
  }

  removePerson(slot) {
    this.people = this.people.filter((p) => p.slot !== slot);
    this.savePeople();
  }
}

export const App = { page: new Page(), SLOTS };
if (typeof window !== "undefined") App.page.ready = App.page.init();
