// The owner's server: one handler for every /api route, used by the local dev server and
// by the hosted function. Public routes answer only what the answer rule allows; /api/owner
// routes need the owner key and are what the owner's own page and assistant use.

import { readFile } from "node:fs/promises";
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { parseIcs } from "./calendar.mjs";
import { answerQuestion, budgetOf, isFree, localLabel, ownerFreeWindows, validateWindows } from "./policy.mjs";
import { AssertionVerifier, PageKey, pageBase } from "./grants.mjs";

const CACHE_MS = 5 * 60000;

export class OwnerServer {
  /**
   * :param opts: {profile, store, ownerKey, loadCalendar?, now?}
   *   loadCalendar returns iCalendar text. now() is overridable for tests.
   */
  /**
   * Hosted pages pass ownerKeyHash (the server never keeps the key) and signingSecret.
   */
  constructor({ profile, store, ownerKey, ownerKeyHash, signingSecret, loadCalendar, now, fetchKey }) {
    this.profile = profile;
    const secret = signingSecret || ownerKey;
    this.pageKey = secret ? new PageKey(secret) : null;
    this.verifier = new AssertionVerifier({ fetchKey, now });
    this.store = store;
    this.ownerKeyHash = ownerKeyHash ? Buffer.from(ownerKeyHash, "hex") : ownerKey ? createHash("sha256").update(ownerKey).digest() : null;
    this.loadCalendar = loadCalendar || (() => defaultCalendarLoader(profile));
    this.now = now || (() => Date.now());
    this.cache = null;
  }

  async events() {
    const t = this.now();
    if (this.cache && t - this.cache.at < CACHE_MS) return this.cache.events;
    const text = await this.loadCalendar();
    const events = parseIcs(text, this.profile.timezone || "UTC");
    this.cache = { at: t, events };
    return events;
  }

  effectiveProfile(state) {
    return { ...this.profile, ...(state.settings || {}) };
  }

  isOwner(headers) {
    if (!this.ownerKeyHash) return false;
    const auth = headers.authorization || headers.Authorization || "";
    const m = /^Bearer\s+(.+)$/.exec(auth);
    if (!m) return false;
    const got = createHash("sha256").update(m[1].trim()).digest();
    return timingSafeEqual(got, this.ownerKeyHash);
  }

  /**
   * :return: {status, body}
   */
  /**
   * :param base: this page's public address (origin plus path), for signed assertions.
   */
  async handle({ method, path, query = {}, headers = {}, body = {}, ip = "", base = "" }) {
    this.ip = ip ? createHash("sha256").update(`overlap:${ip}`).digest("hex").slice(0, 12) : "";
    this.base = base ? pageBase(base) : "";
    try {
      const route = `${method} ${path.replace(/\/+$/, "")}`;
      switch (route) {
        case "GET /api/profile": return ok(await this.publicProfile());
        case "GET /api/key": return this.pageKey ? ok({ ok: true, page: this.base, ...this.pageKey.publicJwk() }) : { status: 404, body: { ok: false, reason: "No key." } };
        case "POST /api/check": return ok(await this.check(body));
        case "POST /api/request": return ok(await this.request(body));
        case "GET /api/request-status": return ok(await this.requestStatus(query.ref));
        case "GET /api/invite.ics": return await this.invite(query.ref);
        case "GET /api/calendar.ics": return await this.feed(query.token);
        case "POST /api/demo-reset": return this.profile.demo ? ok(await this.reset()) : { status: 404, body: { ok: false, reason: "Not found." } };
        default: break;
      }
      if (path.startsWith("/api/owner/")) {
        if (!this.isOwner(headers)) return { status: 401, body: { ok: false, reason: "This needs the owner key." } };
        switch (route) {
          case "GET /api/owner/overview": return ok(await this.overview());
          case "GET /api/owner/free": return ok(await this.ownerFree(query));
          case "POST /api/owner/decide": return ok(await this.decide(body));
          case "POST /api/owner/settings": return ok(await this.settings(body));
          case "POST /api/owner/reset": return ok(await this.reset());
          case "POST /api/owner/assertion": return ok(this.assertion(body));
          case "POST /api/owner/grant": return ok(await this.setGrant(body));
          case "POST /api/owner/delete": return this.onDelete ? ok(await this.onDelete()) : { status: 404, body: { ok: false, reason: "Not found." } };
          default: break;
        }
      }
      return { status: 404, body: { ok: false, reason: "Not found." } };
    } catch (error) {
      console.error("api error", error);
      return { status: 500, body: { ok: false, reason: "The page's server failed. Nothing was changed." } };
    }
  }

  async publicProfile() {
    const state = await this.store.load();
    const p = this.effectiveProfile(state);
    const b = budgetOf(p);
    return {
      ok: true,
      name: p.name, headline: p.headline || "", org: p.org || "", timezone: p.timezone,
      about: p.about || "", topics: p.topics || [], links: p.links || [], initials: p.initials || initials(p.name),
      public_hours: p.public_hours || "",
      // Usual working hours are public by the owner's choice (publish_hours), so other
      // people's assistants can pick sensible windows before they spend budget asking.
      hours: p.publish_hours === false ? null : (p.working_hours || null),
      color: p.color || "#3b5bdb",
      demo: p.demo ? { owner_key: p.demo.owner_key || "", people: p.demo.people || [] } : null,
      answer_mode: p.answer_mode === "helpful" ? "helpful" : "strict",
      rules: {
        max_windows_per_question: b.max_windows_per_question,
        per_page_per_day: b.per_caller_per_day,
        pages_total_per_day: b.total_per_day,
        unverified_per_address_per_day: b.per_ip_per_day,
        unverified_total_per_day: b.anonymous_total_per_day,
        per_week_total: b.per_week_total,
        horizon_days: b.horizon_days,
        minutes: [b.min_minutes, b.max_minutes],
      },
    };
  }

  async verified(body) {
    if (!body.assertion || !this.base) return null;
    const v = await this.verifier.check(body.assertion, this.base, cleanOrigin(body.caller_origin));
    return v.page || null;
  }

  // The owner's own page asks for an assertion to hand to another page's bridge. It signs
  // only for pages on the address the browser reports, and only for the owner.
  assertion(body) {
    if (!this.pageKey || !this.base) return { ok: false, reason: "This page has no signing key." };
    let aud;
    try { aud = pageBase(body.aud); } catch { return { ok: false, reason: "aud must be a page address." }; }
    if (aud === this.base) return { ok: false, reason: "No assertion for this page itself." };
    return { ok: true, assertion: this.pageKey.assert({ iss: this.base, aud, now: this.now() }) };
  }

  async setGrant(body) {
    let page;
    try { page = pageBase(body.page); } catch { return { ok: false, reason: "page must be a page address." }; }
    return this.store.update((state) => {
      state.grants = state.grants || {};
      if (body.reset) delete state.grants[page];
      else if (body.blocked) state.grants[page] = { blocked: true };
      else {
        const n = Math.max(0, Math.min(200, Number(body.per_day)));
        if (!Number.isFinite(n)) return { ok: false, reason: "per_day must be a number." };
        state.grants[page] = { per_day: n, ...(body.trusted ? { trusted: true } : {}) };
      }
      return { ok: true, grants: state.grants };
    });
  }

  async check(body) {
    const events = await this.events();
    const verifiedPage = await this.verified(body);
    return this.store.update((state) => {
      const { result, receipt } = answerQuestion({
        profile: this.effectiveProfile(state), events, state, verifiedPage,
        callerOrigin: cleanOrigin(body.caller_origin), ip: this.ip, purpose: body.purpose, now: this.now(),
      }, body.windows);
      if (receipt) state.receipts.push({ kind: "check", ...receipt });
      return result;
    });
  }

  async request(body) {
    const events = await this.events();
    const verifiedPage = await this.verified(body);
    return this.store.update((state) => {
      const profile = this.effectiveProfile(state);
      const now = this.now();
      const caller = cleanOrigin(body.caller_origin);
      const checked = validateWindows(profile, [{ start: body.start, end: body.end }], now);
      if (checked.reason) return { ok: false, reason: checked.reason };
      const title = String(body.title || "").trim().slice(0, 100);
      const fromName = String(body.from_name || "").trim().slice(0, 80);
      const fromEmail = String(body.from_email || "").trim().slice(0, 120);
      if (!title) return { ok: false, reason: "Give the meeting a short title." };
      // A requester with an Overlap page of their own can be reached there (the reference and
      // its status), so the email is optional; without a page it is how the owner replies.
      const viaPage = !!verifiedPage;
      if (!fromName) return { ok: false, reason: "Enter your name." };
      if (fromEmail ? !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fromEmail) : !viaPage) return { ok: false, reason: "Enter a valid email, so the owner can reply." };
      if (state.grants?.[verifiedPage]?.blocked) return { ok: false, reason: `${profile.name} has not given this page access.` };
      const pendingFromCaller = state.requests.filter((r) => r.status === "pending" && r.caller === caller).length;
      if (pendingFromCaller >= 5) return { ok: false, reason: `${profile.name} already has 5 open requests from this site. Wait for an answer first.` };
      const w = checked.windows[0];
      const accepted = state.requests.filter((r) => r.status === "accepted");
      const free = isFree(profile, events, accepted, w.start, w.end);
      state.receipts.push({ kind: "request", at: now, caller: verifiedPage || caller, page: verifiedPage, verified: !!verifiedPage, ip: this.ip, purpose: title, asked: [{ start: iso(w.start), end: iso(w.end) }], answers: [free], suggestions: [], cost: 1, refused: false });
      if (!free) return { ok: false, reason: `${profile.name} is not free then any more. Ask about other times.` };
      const ref = `OV-${randomBytes(3).toString("hex").toUpperCase()}`;
      state.requests.push({
        ref, status: "pending", created: now, caller, start: iso(w.start), end: iso(w.end), title,
        from_name: fromName, from_email: fromEmail, from_page: verifiedPage || "", note: String(body.note || "").slice(0, 400),
      });
      return { ok: true, reference: ref, status: "pending", start: iso(w.start), end: iso(w.end), local: localLabel(w.start, profile.timezone), message: `Sent to ${profile.name}. It stays pending until ${profile.name} accepts it.` };
    });
  }

  async requestStatus(ref) {
    const state = await this.store.load();
    const r = state.requests.find((x) => x.ref === String(ref || "").trim().toUpperCase());
    if (!r) return { ok: false, reason: "No request with that reference." };
    return {
      ok: true, reference: r.ref, status: r.status, start: r.start, end: r.end, title: r.title,
      ...(r.status === "accepted" ? { invite: `/api/invite.ics?ref=${r.ref}`, note: "Accepted. The invite link is a standard .ics file for any calendar." } : {}),
    };
  }

  // A standard iCalendar invite for an accepted request. The reference is the capability:
  // whoever sent the request holds it.
  async invite(ref) {
    const state = await this.store.load();
    const r = state.requests.find((x) => x.ref === String(ref || "").trim().toUpperCase());
    if (!r || r.status !== "accepted") return { status: 404, body: { ok: false, reason: "No accepted request with that reference." } };
    return { status: 200, ics: toIcs([r], this.profile, `Overlap: ${r.title}`) };
  }

  // The owner subscribes to this feed in their calendar app, so accepted meetings appear
  // there without giving Overlap write access to the calendar.
  feedToken() {
    return this.ownerKeyHash ? createHash("sha256").update(Buffer.concat([this.ownerKeyHash, Buffer.from("feed")])).digest("hex").slice(0, 32) : null;
  }

  async feed(token) {
    const want = this.feedToken();
    if (!want || String(token || "") !== want) return { status: 404, body: { ok: false, reason: "Not found." } };
    const state = await this.store.load();
    return { status: 200, ics: toIcs(state.requests.filter((r) => r.status === "accepted"), this.profile, `${this.profile.name}: meetings accepted on Overlap`) };
  }

  async overview() {
    const state = await this.store.load();
    const p = this.effectiveProfile(state);
    const b = budgetOf(p);
    const now = this.now();
    const recent = state.receipts.filter((r) => r.at >= now - 86400000);
    const bySite = {};
    for (const r of recent) bySite[r.caller] = (bySite[r.caller] || 0) + r.cost;
    const pagesUsed = recent.filter((r) => r.page).reduce((n, r) => n + r.cost, 0);
    return {
      ok: true,
      profile: { name: p.name, timezone: p.timezone, answer_mode: p.answer_mode === "helpful" ? "helpful" : "strict" },
      budget: { per_page_per_day: b.per_caller_per_day, total_per_day: b.total_per_day + b.anonymous_total_per_day, pages_total_per_day: b.total_per_day, pages_used_today: pagesUsed, unverified_total_per_day: b.anonymous_total_per_day, unverified_used_today: recent.reduce((n, r) => n + r.cost, 0) - pagesUsed, used_today: recent.reduce((n, r) => n + r.cost, 0), by_site: bySite },
      receipts: state.receipts.slice(-60).reverse(),
      requests: [...state.requests].reverse(),
      calendar_feed: `/api/calendar.ics?token=${this.feedToken()}`,
      grants: state.grants || {},
      pages: [...new Set(state.receipts.filter((r) => r.page).map((r) => r.page))],
    };
  }

  async ownerFree(query) {
    const events = await this.events();
    const state = await this.store.load();
    const now = this.now();
    const from = Date.parse(query.from) || now;
    const to = Date.parse(query.to) || from + 7 * 86400000;
    const minutes = Math.min(120, Math.max(15, Number(query.minutes) || 30));
    if (to - from > 21 * 86400000) return { ok: false, reason: "Ask for at most 21 days at a time." };
    return { ok: true, timezone: this.profile.timezone, minutes, free: ownerFreeWindows(this.effectiveProfile(state), events, state, from, to, minutes, now) };
  }

  async decide(body) {
    return this.store.update((state) => {
      const r = state.requests.find((x) => x.ref === body.ref);
      if (!r) return { ok: false, reason: "No request with that reference." };
      if (r.status !== "pending") return { ok: false, reason: `That request is already ${r.status}.` };
      if (!["accepted", "declined"].includes(body.decision)) return { ok: false, reason: "Decide accepted or declined." };
      r.status = body.decision;
      r.decided = this.now();
      return { ok: true, reference: r.ref, status: r.status };
    });
  }

  async settings(body) {
    return this.store.update((state) => {
      state.settings = state.settings || {};
      if (body.answer_mode) {
        if (!["strict", "helpful"].includes(body.answer_mode)) return { ok: false, reason: "answer_mode is strict or helpful." };
        state.settings.answer_mode = body.answer_mode;
      }
      return { ok: true, settings: state.settings };
    });
  }

  async reset() {
    return this.store.update((state) => { state.receipts = []; state.requests = []; state.grants = {}; return { ok: true }; });
  }
}

function ok(body) { return { status: 200, body }; }

function icsTime(iso) { return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); }
function icsText(s) { return String(s || "").replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n"); }

export function toIcs(requests, profile, calName) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Overlap//Answer-only scheduling//EN", "METHOD:PUBLISH", `X-WR-CALNAME:${icsText(calName)}`];
  for (const r of requests) {
    lines.push("BEGIN:VEVENT", `UID:${r.ref}@overlap`, `DTSTAMP:${icsTime(new Date(r.decided || r.created || Date.now()).toISOString())}`,
      `DTSTART:${icsTime(r.start)}`, `DTEND:${icsTime(r.end)}`, `SUMMARY:${icsText(r.title)}`,
      `DESCRIPTION:${icsText(`Meeting between ${profile.name} and ${r.from_name}. Arranged through Overlap (reference ${r.ref}).${r.note ? ` Note: ${r.note}` : ""}`)}`,
      ...(r.from_email ? [`ATTENDEE;CN=${icsText(r.from_name)}:mailto:${r.from_email}`] : []), ...(r.from_page ? [`URL:${r.from_page}/`] : []), "STATUS:CONFIRMED", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
function iso(ts) { return new Date(ts).toISOString(); }
function initials(name) { return String(name || "?").split(/\s+/).map((s) => s[0]).join("").slice(0, 2).toUpperCase(); }

// The caller's origin is a label for its budget bucket, never a credential: the owner's
// page reports it from the browser's postMessage origin, and the total budget caps liars.
export function cleanOrigin(v) {
  try { return new URL(String(v)).origin; } catch { return "unknown"; }
}

async function defaultCalendarLoader(profile) {
  const url = process.env.CALENDAR_ICS_URL || profile.calendar?.ics_url;
  if (url) {
    const r = await fetch(url, { headers: { Accept: "text/calendar" } });
    if (!r.ok) throw new Error(`calendar ${r.status}`);
    return r.text();
  }
  if (profile.calendar?.ics) return profile.calendar.ics;
  if (profile.calendar?.ics_file) return readFile(profile.calendar.ics_file, "utf8");
  return "";
}
