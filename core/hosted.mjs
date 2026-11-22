// Hosted Overlap: many people's pages on one site, each at /u/<id>/, created by pasting a
// calendar's private iCal address. Each page is a full open agentic site (its own manifest,
// networks, bridge, key and answer rules) under its own path; the spec allows a site base to
// be a path. Self-hosting on your own origin remains the strongest setup.
//
// What the host keeps per page: the profile, the iCal address (read only by this server, to
// answer yes or no), a hash of the owner key, a signing seed, receipts and requests. The owner
// can delete the page, which deletes all of it.

import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { OwnerServer } from "./api.mjs";
import { parseIcs } from "./calendar.mjs";

const PALETTE = ["#2f6f5e", "#8a4b2a", "#4b3f8a", "#1f5f8a", "#7a2f55", "#5a6b1f"];
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_NAMES = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

export class HostedPages {
  /**
   * :param opts: {registry, storeFor(id), fetchIcs?(url), allowPrivateCalendarHosts?, now?}
   *   registry: a store holding {pages: {id: record}}; storeFor(id): that page's own store.
   */
  constructor({ registry, storeFor, fetchIcs, allowPrivateCalendarHosts = false, now }) {
    this.registry = registry;
    this.storeFor = storeFor;
    this.fetchIcs = fetchIcs || defaultFetchIcs;
    this.allowPrivate = allowPrivateCalendarHosts;
    this.now = now || (() => Date.now());
    this.servers = new Map();
  }

  /**
   * Route one request. :param base: the site's origin, such as https://overlap.example.
   */
  async handle({ method, path, query = {}, headers = {}, body = {}, ip = "", origin }) {
    if (method === "POST" && path === "/api/pages") return this.create(body, ip, origin);
    const m = /^\/u\/([a-z0-9-]{3,40})(\/api\/.*)$/.exec(path);
    if (!m) return { status: 404, body: { ok: false, reason: "Not found." } };
    const server = await this.serverFor(m[1]);
    if (!server) return { status: 404, body: { ok: false, reason: "No such page." } };
    return server.handle({ method, path: m[2], query, headers, body, ip, base: `${origin}/u/${m[1]}` });
  }

  async serverFor(id) {
    if (this.servers.has(id)) return this.servers.get(id);
    const reg = await this.registry.load();
    const rec = reg.pages?.[id];
    if (!rec) return null;
    const server = new OwnerServer({
      profile: rec.profile, store: this.storeFor(id), ownerKeyHash: rec.owner_key_hash, signingSecret: rec.signing_seed,
      loadCalendar: () => this.fetchIcs(rec.ics_url, this.allowPrivate), now: this.now,
    });
    server.onDelete = () => this.remove(id);
    this.servers.set(id, server);
    return server;
  }

  async remove(id) {
    await this.registry.update((reg) => { delete reg.pages?.[id]; });
    await this.storeFor(id).save({ receipts: [], requests: [] });
    this.servers.delete(id);
    return { ok: true, deleted: id };
  }

  async create(body, ip, origin) {
    const name = String(body.name || "").trim().slice(0, 60);
    const timezone = String(body.timezone || "").trim();
    const icsUrl = String(body.ics_url || "").trim();
    if (!name) return bad("Enter your name.");
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { return bad("Pick a valid time zone."); }
    if (!timezone) return bad("Pick a valid time zone.");
    const [from, to] = [String(body.from || "09:00"), String(body.to || "17:00")];
    if (!/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to) || from >= to) return bad("Working hours must look like 09:00 to 17:00.");
    const days = (Array.isArray(body.days) && body.days.length ? body.days : ["mon", "tue", "wed", "thu", "fri"]).filter((d) => DAYS.includes(d));
    if (!days.length) return bad("Pick at least one working day.");
    // Fetch the calendar once now, so a wrong address fails here, not when someone asks.
    let events;
    try { events = parseIcs(await this.fetchIcs(icsUrl, this.allowPrivate), timezone); }
    catch (e) { return bad(`Could not read that calendar address (${e.message}). Use the private iCal address from your calendar's settings.`); }
    const ipKey = createHash("sha256").update(`create:${ip}`).digest("hex").slice(0, 12);
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const ownerKey = randomBytes(18).toString("base64url");
    const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "page";
    const id = `${slug}-${randomBytes(2).toString("hex")}`;
    const created = await this.registry.update((reg) => {
      reg.pages = reg.pages || {};
      reg.creations = (reg.creations || []).filter((c) => c.day === day);
      if (reg.creations.filter((c) => c.ip === ipKey).length >= 5) return false;
      reg.creations.push({ day, ip: ipKey });
      const hours = Object.fromEntries(days.map((d) => [d, [from, to]]));
      reg.pages[id] = {
        created: this.now(), ics_url: icsUrl, signing_seed: randomBytes(32).toString("hex"),
        owner_key_hash: createHash("sha256").update(ownerKey).digest("hex"),
        profile: {
          id, name, timezone, headline: String(body.headline || "").slice(0, 80), org: String(body.org || "").slice(0, 80),
          about: String(body.about || "").slice(0, 300),
          topics: String(body.topics || "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 6),
          color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
          public_hours: `${days.map((d) => DAY_NAMES[d]).join(", ")} ${from}–${to} (${timezone})`,
          working_hours: hours, protected: [], buffer_minutes: 0, max_meetings_per_day: 8, answer_mode: "strict",
        },
      };
      return true;
    });
    if (!created) return { status: 429, body: { ok: false, reason: "Too many pages from this network today." } };
    return { status: 200, body: { ok: true, id, page_url: `${origin}/u/${id}/`, owner_key: ownerKey, events_read: events.length,
      note: "Keep the owner key: it is shown once. It signs you in as the owner of your page." } };
  }
}

function bad(reason) { return { status: 400, body: { ok: false, reason } }; }

// Fetch a calendar by its private iCal address. Only https, and never a private network
// address, so the server cannot be pointed at its own network.
export async function defaultFetchIcs(url, allowPrivate = false) {
  let u;
  try { u = new URL(String(url).replace(/^webcal:/i, "https:")); } catch { throw new Error("not an address"); }
  if (u.protocol !== "https:" && !(allowPrivate && u.protocol === "http:")) throw new Error("needs https");
  if (!allowPrivate) {
    const addrs = isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true });
    if (addrs.some(({ address }) => isPrivate(address))) throw new Error("private address");
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(u, { signal: ctrl.signal, redirect: "error", headers: { Accept: "text/calendar" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    if (!/BEGIN:VCALENDAR/.test(text.slice(0, 2000))) throw new Error("not an iCal file");
    return text.slice(0, 5_000_000);
  } finally { clearTimeout(t); }
}

function isPrivate(a) {
  return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1$|fc|fd|fe80:)/i.test(a) || a === "::";
}
