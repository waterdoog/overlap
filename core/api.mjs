
// The owner's server: one handler for every /api route, used by the local dev server and
// by the hosted function. Public routes answer only what the answer rule allows; /api/owner
// routes need the owner key and are what the owner's own page and assistant use.

import { readFile } from "node:fs/promises";
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { parseIcs } from "./calendar.mjs";
import { answerQuestion, blockingRequestsFor, budgetOf, isFree, localLabel, minNoticeMs, ownerFreeWindows, validateWindows } from "./policy.mjs";
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
        case "GET /api/stats": return ok(await this.statsView());
        case "POST /api/stats": return ok(await this.count(body.event === "demo" ? "demo" : null));
        case "GET /api/key": return this.pageKey ? ok({ ok: true, page: this.base, ...this.pageKey.publicJwk() }) : { status: 404, body: { ok: false, reason: "No key." } };
        case "POST /api/check": return ok(await this.check(body));
        case "POST /api/request": return ok(await this.request(body));
        case "POST /api/cancel": return ok(await this.requesterCancel(body));
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
          case "POST /api/owner/cancel": return ok(await this.ownerCancel(body));
          case "POST /api/owner/settings": return ok(await this.settings(body));
          case "POST /api/owner/reset": return ok(await this.reset(!!body.stats));
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
    const minNotice = Number(p.min_notice_hours || 0);
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
        ...(minNotice > 0 ? { min_notice_hours: minNotice } : {}),
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

  // Anonymous usage: counts of events per day, nothing about who or what.
  static bump(state, event, now) {
    if (!event) return;
    const day = new Date(now).toISOString().slice(0, 10);
    state.stats = state.stats || {};
    const d = (state.stats[day] ||= {});
    d[event] = (d[event] || 0) + 1;
    for (const k of Object.keys(state.stats).sort().slice(0, -60)) delete state.stats[k];
  }

  async count(event) {
    if (!event) return { ok: false, reason: "Unknown event." };
    return this.store.update((state) => { OwnerServer.bump(state, event, this.now()); return { ok: true }; });
  }

  async statsView() {
    const state = await this.store.load();
    const days = Object.entries(state.stats || {}).sort(([a], [b]) => a.localeCompare(b));
    const total = {}, week = {};
    const since = new Date(this.now() - 7 * 864e5).toISOString().slice(0, 10);
    for (const [day, ev] of days) for (const [k, n] of Object.entries(ev)) { total[k] = (total[k] || 0) + n; if (day >= since) week[k] = (week[k] || 0) + n; }
    return { ok: true, note: "Anonymous counts of events per day (questions answered, requests, acceptances, demo runs). Nothing about who asked or what.", last_7_days: week, all_time: total, by_day: Object.fromEntries(days) };
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
      if (result.ok) OwnerServer.bump(state, "check", this.now());
      return result;
    });
  }

  async request(body) {
    const verifiedPage = await this.verified(body);
    const snapshot = await this.store.load();
    const snapProfile = this.effectiveProfile(snapshot);
    const willAutoAccept = !!(snapProfile.auto_accept_trusted && verifiedPage && snapshot.grants?.[verifiedPage]?.trusted);
    if (willAutoAccept) this.cache = null; // fresh conflict re-check, same as owner decide
    const events = await this.events();
    return this.store.update((state) => {
      const profile = this.effectiveProfile(state);
      const now = this.now();
      const caller = cleanOrigin(body.caller_origin);
      const checked = validateWindows(profile, [{ start: body.start, end: body.end }], now);
      if (checked.reason) return { ok: false, reason: checked.reason };
      const w = checked.windows[0];
      const noticeMs = minNoticeMs(profile);
      if (noticeMs > 0 && w.start < now + noticeMs) {
        const hrs = Number(profile.min_notice_hours);
        return { ok: false, reason: `${profile.name} requires at least ${hrs} hour${hrs === 1 ? "" : "s"} of notice before a meeting.` };
      }
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
      const { accepted, blocking } = blockingRequestsFor(profile, state, verifiedPage);
      const free = isFree(profile, events, accepted, w.start, w.end, now, blocking);
      state.receipts.push({ kind: "request", at: now, caller: verifiedPage || caller, page: verifiedPage, verified: !!verifiedPage, trusted: !!state.grants?.[verifiedPage]?.trusted, ip: this.ip, purpose: title, asked: [{ start: iso(w.start), end: iso(w.end) }], answers: [free], suggestions: [], cost: 1, refused: false });
      if (!free) return { ok: false, reason: `${profile.name} is not free then any more. Ask about other times.` };
      const ref = `OV-${randomBytes(3).toString("hex").toUpperCase()}`;
      const cancelToken = randomBytes(16).toString("base64url");
      const autoAccept = !!(profile.auto_accept_trusted && verifiedPage && state.grants?.[verifiedPage]?.trusted && isFree(profile, events, accepted, w.start, w.end, now, accepted));
      OwnerServer.bump(state, "request", now);
      const reqObj = {
        ref, status: autoAccept ? "accepted" : "pending", created: now,
        ...(autoAccept ? { decided: now } : {}),
        caller, verified: !!verifiedPage, start: iso(w.start), end: iso(w.end), title,
        from_name: fromName, from_email: fromEmail, from_page: verifiedPage || "", note: String(body.note || "").slice(0, 400),
        cancel_token: cancelToken,
      };
      state.requests.push(reqObj);
      if (autoAccept) {
        OwnerServer.bump(state, "accept", now);
        const links = calendarLinks(reqObj, profile);
        return {
          ok: true, reference: ref, status: "accepted", cancel_token: cancelToken,
          start: reqObj.start, end: reqObj.end, local: localLabel(w.start, profile.timezone),
          invite: `/api/invite.ics?ref=${ref}`, ...links,
          message: `Booked with ${profile.name}. Your trusted page is set for instant booking.`,
        };
      }
      return {
        ok: true, reference: ref, status: "pending", cancel_token: cancelToken,
        start: reqObj.start, end: reqObj.end, local: localLabel(w.start, profile.timezone),
        message: `Sent to ${profile.name}. It stays pending until ${profile.name} accepts it.`,
      };
    });
  }

  async requesterCancel(body) {
    const ref = String(body.ref || "").trim().toUpperCase();
    const given = String(body.cancel_token || "");
    if (!ref || !given) return { ok: false, reason: "Provide ref and cancel_token." };
    return this.store.update((state) => {
      const r = state.requests.find((x) => x.ref === ref);
      if (!r || !r.cancel_token) return { ok: false, reason: "Invalid reference or cancel token." };
      const a = Buffer.from(given, "utf8");
      const b = Buffer.from(String(r.cancel_token), "utf8");
      if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "Invalid reference or cancel token." };
      if (r.status === "cancelled") return { ok: true, reference: r.ref, status: "cancelled" };
      if (!["pending", "accepted"].includes(r.status)) return { ok: false, reason: `Cannot cancel a ${r.status} request.` };
      r.was_accepted = r.status === "accepted";
      r.status = "cancelled";
      r.cancelled = this.now();
      r.by = "requester";
      return { ok: true, reference: r.ref, status: "cancelled" };
    });
  }

  async ownerCancel(body) {
    const ref = String(body.ref || "").trim().toUpperCase();
    if (!ref) return { ok: false, reason: "No request with that reference." };
    return this.store.update((state) => {
      const r = state.requests.find((x) => x.ref === ref);
      if (!r) return { ok: false, reason: "No request with that reference." };
      if (!["pending", "accepted"].includes(r.status)) return { ok: false, reason: `That request is already ${r.status}.` };
      r.was_accepted = r.status === "accepted";
      r.status = "cancelled";
      r.cancelled = this.now();
      r.by = "owner";
      return { ok: true, reference: r.ref, status: "cancelled" };
    });
  }

  async requestStatus(ref) {
    const state = await this.store.load();
    const profile = this.effectiveProfile(state);
    const r = state.requests.find((x) => x.ref === String(ref || "").trim().toUpperCase());
    if (!r) return { ok: false, reason: "No request with that reference." };
    return {
      ok: true, reference: r.ref, status: r.status, start: r.start, end: r.end, title: r.title,
      ...(r.status === "accepted" ? {
        invite: `/api/invite.ics?ref=${r.ref}`,
        ...calendarLinks(r, profile),
        note: "Accepted. The invite link is a standard .ics file for any calendar.",
      } : {}),
      ...(r.status === "cancelled" ? { note: "This meeting has been cancelled." } : {}),
    };
  }

  // A standard iCalendar invite for an accepted request (or METHOD:CANCEL for a cancelled one).
  // The reference is the capability: whoever sent the request holds it.
  async invite(ref) {
    const state = await this.store.load();
    const profile = this.effectiveProfile(state);
    const r = state.requests.find((x) => x.ref === String(ref || "").trim().toUpperCase());
    const acceptedThenCancelled = r && r.status === "cancelled" && !!(r.was_accepted ?? r.decided);
    if (!r || (r.status !== "accepted" && !acceptedThenCancelled)) {
      return { status: 404, body: { ok: false, reason: "No accepted request with that reference." } };
    }
    if (r.status === "cancelled") {
      return { status: 200, ics: toCancelIcs(r, profile, `Overlap: ${r.title}`) };
    }
    return { status: 200, ics: toIcs([r], profile, `Overlap: ${r.title}`) };
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
    const profile = this.effectiveProfile(state);
    const items = state.requests.filter((r) => r.status === "accepted" || (r.status === "cancelled" && !!(r.was_accepted ?? r.decided)));
    return { status: 200, ics: toIcs(items, profile, `${profile.name}: meetings accepted on Overlap`) };
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
    const safeRequests = [...state.requests].reverse().map(({ cancel_token, ...rest }) => ({
      ...rest,
      ...(rest.status === "accepted" ? calendarLinks(rest, p) : {}),
    }));
    return {
      ok: true,
      profile: {
        name: p.name,
        timezone: p.timezone,
        answer_mode: p.answer_mode === "helpful" ? "helpful" : "strict",
        auto_accept_trusted: !!p.auto_accept_trusted,
        min_notice_hours: Number(p.min_notice_hours || 0),
        hold_pending: p.hold_pending !== false,
      },
      budget: { per_page_per_day: b.per_caller_per_day, total_per_day: b.total_per_day + b.anonymous_total_per_day, pages_total_per_day: b.total_per_day, pages_used_today: pagesUsed, unverified_total_per_day: b.anonymous_total_per_day, unverified_used_today: recent.reduce((n, r) => n + r.cost, 0) - pagesUsed, used_today: recent.reduce((n, r) => n + r.cost, 0), by_site: bySite },
      receipts: state.receipts.slice(-60).reverse(),
      requests: safeRequests,
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
    // Re-read the calendar before accepting: it may have changed since the request came in.
    this.cache = null;
    const events = await this.events();
    return this.store.update((state) => {
      const r = state.requests.find((x) => x.ref === body.ref);
      if (!r) return { ok: false, reason: "No request with that reference." };
      if (r.status !== "pending") return { ok: false, reason: `That request is already ${r.status}.` };
      if (!["accepted", "declined"].includes(body.decision)) return { ok: false, reason: "Decide accepted or declined." };
      if (body.decision === "accepted") {
        const others = state.requests.filter((x) => x.status === "accepted" && x.ref !== r.ref);
        if (!isFree(this.effectiveProfile(state), events, others, Date.parse(r.start), Date.parse(r.end))) {
          return { ok: false, conflict: true, reason: "You are no longer free then: your calendar or another accepted meeting now overlaps. Decline it, or accept after freeing the time." };
        }
      }
      r.status = body.decision;
      r.decided = this.now();
      if (r.status === "accepted") OwnerServer.bump(state, "accept", r.decided);
      return { ok: true, reference: r.ref, status: r.status };
    });
  }

  async settings(body) {
    return this.store.update((state) => {
      state.settings = state.settings || {};
      if (body.answer_mode !== undefined) {
        if (!["strict", "helpful"].includes(body.answer_mode)) return { ok: false, reason: "answer_mode is strict or helpful." };
        state.settings.answer_mode = body.answer_mode;
      }
      if (body.auto_accept_trusted !== undefined) {
        if (typeof body.auto_accept_trusted !== "boolean") return { ok: false, reason: "auto_accept_trusted must be a boolean." };
        state.settings.auto_accept_trusted = body.auto_accept_trusted;
      }
      if (body.min_notice_hours !== undefined) {
        const h = Number(body.min_notice_hours);
        if (!Number.isFinite(h) || h < 0 || h > 168) return { ok: false, reason: "min_notice_hours must be a number between 0 and 168." };
        state.settings.min_notice_hours = h;
      }
      if (body.hold_pending !== undefined) {
        if (typeof body.hold_pending !== "boolean") return { ok: false, reason: "hold_pending must be a boolean." };
        state.settings.hold_pending = body.hold_pending;
      }
      return { ok: true, settings: state.settings };
    });
  }

  async reset(clearStats = false) {
    // Clears the demo log; anonymous usage counts stay unless the owner asks (e.g. after tests).
    return this.store.update((state) => { state.receipts = []; state.requests = []; state.grants = {}; if (clearStats) state.stats = {}; return { ok: true }; });
  }
}

function ok(body) { return { status: 200, body }; }

function icsTime(isoStr) { return new Date(isoStr).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); }
function icsText(s) { return String(s || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n"); }
function icsParamText(s) { return icsText(s).replace(/[:"]/g, ""); }
function icsUri(s) { return String(s || "").replace(/[\r\n]+/g, ""); }

export function calendarLinks(r, profile) {
  const details = `Meeting between ${profile.name} and ${r.from_name}. Arranged through Overlap (reference ${r.ref}).${r.note ? ` Note: ${r.note}` : ""}`;
  const dates = `${icsTime(r.start)}/${icsTime(r.end)}`;
  const startIso = new Date(r.start).toISOString();
  const endIso = new Date(r.end).toISOString();
  const google_calendar = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(r.title)}&dates=${encodeURIComponent(dates)}&details=${encodeURIComponent(details)}`;
  const outlook_calendar = `https://outlook.live.com/calendar/0/deeplink/compose?subject=${encodeURIComponent(r.title)}&startdt=${encodeURIComponent(startIso)}&enddt=${encodeURIComponent(endIso)}&body=${encodeURIComponent(details)}`;
  return { google_calendar, outlook_calendar };
}

export function toIcs(requests, profile, calName) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Overlap//Answer-only scheduling//EN", "METHOD:PUBLISH", `X-WR-CALNAME:${icsText(calName)}`];
  for (const r of requests) {
    const cancelled = r.status === "cancelled";
    const stamp = r.cancelled || r.decided || r.created || Date.now();
    lines.push("BEGIN:VEVENT", `UID:${icsUri(r.ref)}@overlap`, `DTSTAMP:${icsTime(new Date(stamp).toISOString())}`,
      `DTSTART:${icsTime(r.start)}`, `DTEND:${icsTime(r.end)}`, `SUMMARY:${icsText(r.title)}`,
      `DESCRIPTION:${icsText(`Meeting between ${profile.name} and ${r.from_name}. Arranged through Overlap (reference ${r.ref}).${r.note ? ` Note: ${r.note}` : ""}`)}`,
      ...(r.from_email ? [`ATTENDEE;CN=${icsParamText(r.from_name)}:mailto:${icsUri(r.from_email)}`] : []),
      ...(r.from_page ? [`URL:${icsUri(r.from_page)}/`] : []),
      ...(cancelled ? ["SEQUENCE:1", "STATUS:CANCELLED"] : ["STATUS:CONFIRMED"]),
      "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

export function toCancelIcs(r, profile, calName) {
  const stamp = r.cancelled || r.decided || r.created || Date.now();
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Overlap//Answer-only scheduling//EN", "METHOD:CANCEL", `X-WR-CALNAME:${icsText(calName)}`,
    "BEGIN:VEVENT", `UID:${icsUri(r.ref)}@overlap`, `DTSTAMP:${icsTime(new Date(stamp).toISOString())}`,
    `DTSTART:${icsTime(r.start)}`, `DTEND:${icsTime(r.end)}`, `SUMMARY:${icsText(r.title)}`,
    `DESCRIPTION:${icsText(`Cancelled meeting between ${profile.name} and ${r.from_name} (reference ${r.ref}).`)}`,
    ...(r.from_email ? [`ATTENDEE;CN=${icsParamText(r.from_name)}:mailto:${icsUri(r.from_email)}`] : []),
    ...(r.from_page ? [`URL:${icsUri(r.from_page)}/`] : []),
    "SEQUENCE:1", "STATUS:CANCELLED", "END:VEVENT", "END:VCALENDAR",
  ];
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
