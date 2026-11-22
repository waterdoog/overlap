import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseIcs, busyIntervals } from "../core/calendar.mjs";
import { answerQuestion, isFree, ownerFreeWindows } from "../core/policy.mjs";
import { OwnerServer } from "../core/api.mjs";
import { MemoryStore } from "../core/store.mjs";

const load = (id) => { const p = JSON.parse(readFileSync(new URL(`../personas/${id}.json`, import.meta.url))); p.calendar = { ics: readFileSync(new URL(`../personas/${id}.ics`, import.meta.url), "utf8") }; return p; };
// Sunday 22 Nov 2026 00:00 UTC; next Thursday is 26 Nov.
const NOW = Date.parse("2026-11-22T00:00:00Z");
const T = (s) => Date.parse(s);
const people = ["ana", "bo", "cy"].map(load);
const evs = people.map((p) => parseIcs(p.calendar.ics, p.timezone));

test("recurring events land on the right UTC times", () => {
  const busy = busyIntervals(evs[1], T("2026-11-26T00:00:00Z"), T("2026-11-27T00:00:00Z"));
  assert.ok(busy.some(([s, e]) => s === T("2026-11-26T14:00:00Z") && e === T("2026-11-26T14:30:00Z")), "Bo board prep Thu 14:00 UTC");
  const cy = busyIntervals(evs[2], T("2026-11-26T00:00:00Z"), T("2026-11-27T00:00:00Z"));
  assert.ok(cy.some(([s]) => s === T("2026-11-26T14:00:00Z")), "Cy standup 9:00 Toronto = 14:00 UTC");
});

test("only Thursday 14:30 UTC is common to all three", () => {
  const free = (i, s) => isFree(people[i], evs[i], [], T(s), T(s) + 30 * 60000);
  assert.equal([0, 1, 2].every((i) => free(i, "2026-11-26T14:30:00Z")), true);
  for (const s of ["2026-11-23T15:00:00Z", "2026-11-24T14:00:00Z", "2026-11-25T14:00:00Z", "2026-11-26T14:00:00Z", "2026-11-26T15:00:00Z"]) {
    assert.equal([0, 1, 2].every((i) => free(i, s)), false, s);
  }
});

test("strict answers are booleans only and spend budget", () => {
  const state = { receipts: [], requests: [] };
  const { result, receipt } = answerQuestion({ profile: people[1], events: evs[1], state, callerOrigin: "https://ana.example", verifiedPage: "https://ana.example", now: NOW },
    [{ start: "2026-11-26T14:00:00Z", end: "2026-11-26T14:30:00Z" }, { start: "2026-11-26T14:30:00Z", end: "2026-11-26T15:00:00Z" }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.answers.map((a) => a.available), [false, true]);
  assert.deepEqual(result.suggestions, []);
  assert.equal(JSON.stringify(result).includes("Board"), false, "no titles leak");
  assert.equal(receipt.cost, 2);
  assert.equal(result.budget_left, 16);
});

test("unverified askers share a small pool, held per network address", () => {
  const profile = { ...people[1], budget: { per_ip_per_day: 4, anonymous_total_per_day: 6 } };
  const state = { receipts: [], requests: [] };
  const ask = (origin, ip, n, day = 23) => {
    const ws = Array.from({ length: n }, (_, i) => ({ start: `2026-11-${day}T1${i}:00:00Z`, end: `2026-11-${day}T1${i}:30:00Z` }));
    const out = answerQuestion({ profile, events: evs[1], state, callerOrigin: origin, ip, now: NOW }, ws);
    if (out.receipt) state.receipts.push(out.receipt);
    return out.result;
  };
  assert.equal(ask("https://a.example", "ip1", 3).ok, true);
  const r = ask("https://b.example", "ip1", 2);
  assert.equal(r.ok, false, "a new claimed origin from the same address gets no fresh budget"); assert.match(r.reason, /only 1 more/);
  assert.equal(ask("https://c.example", "ip2", 3).ok, true);
  assert.equal(ask("https://d.example", "ip3", 1).ok, false, "the anonymous total caps everyone unverified");
});

test("signed assertions: verified pages get their own budget, owners can block them, forgeries fail", async () => {
  const ana = new OwnerServer({ profile: people[0], store: new MemoryStore(), ownerKey: "ka", now: () => NOW });
  const keys = { "https://ana.example": (await ana.handle({ method: "GET", path: "/api/key", base: "https://ana.example" })).body };
  const bo = new OwnerServer({ profile: { ...people[1], budget: { anonymous_total_per_day: 0 } }, store: new MemoryStore(), ownerKey: "kb", now: () => NOW, fetchKey: async (iss) => keys[iss] });
  const BO = "https://bo.example";
  const sign = async (aud) => (await ana.handle({ method: "POST", path: "/api/owner/assertion", headers: { authorization: "Bearer ka" }, body: { aud }, base: "https://ana.example" })).body.assertion;
  const ask = (assertion, caller = "https://ana.example") => bo.handle({ method: "POST", path: "/api/check", base: BO, ip: "1.2.3.4",
    body: { caller_origin: caller, assertion, windows: [{ start: "2026-11-26T14:30:00Z", end: "2026-11-26T15:00:00Z" }] } }).then((r) => r.body);
  assert.equal((await ana.handle({ method: "POST", path: "/api/owner/assertion", body: { aud: BO }, base: "https://ana.example" })).status, 401, "only the owner gets assertions");
  const t = await sign(BO);
  assert.equal((await ask("")).ok, false, "unverified pool is empty in this test");
  assert.equal((await ask(t)).ok, true, "signed question is answered from Ana's own bucket");
  assert.equal((await ask(await sign("https://cy.example"))).ok, false, "assertion for another page is not accepted");
  assert.equal((await ask(t, "https://evil.example")).ok, false, "assertion must come from the asking page's origin");
  const [body] = t.split(".");
  const forged = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), iss: "https://ana.example", exp: NOW + 99 })).toString("base64url")}.${t.split(".")[1]}`;
  assert.equal((await ask(forged)).ok, false, "tampered assertion fails the signature");
  await bo.handle({ method: "POST", path: "/api/owner/grant", headers: { authorization: "Bearer kb" }, body: { page: "https://ana.example", blocked: true }, base: BO });
  assert.match((await ask(t)).reason, /has not given this page access/);
  await bo.handle({ method: "POST", path: "/api/owner/grant", headers: { authorization: "Bearer kb" }, body: { page: "https://ana.example", reset: true }, base: BO });
  const req = await bo.handle({ method: "POST", path: "/api/request", base: BO, body: { start: "2026-11-26T14:30:00Z", end: "2026-11-26T15:00:00Z", title: "Sync", from_name: "Ana", caller_origin: "https://ana.example", assertion: t } });
  assert.equal(req.body.ok, true, "a signed page may leave out the email");
  const ov = (await bo.handle({ method: "GET", path: "/api/owner/overview", headers: { authorization: "Bearer kb" }, base: BO })).body;
  assert.equal(ov.requests[0].from_page, "https://ana.example");
  assert.deepEqual(ov.pages, ["https://ana.example"]);
  assert.equal(ov.receipts.find((r) => r.answers.length).verified, true);
});

test("helpful mode offers at most two nearby windows when none asked is free", () => {
  const state = { receipts: [], requests: [] };
  const { result } = answerQuestion({ profile: people[0], events: evs[0], state, callerOrigin: "https://bo.example", now: NOW },
    [{ start: "2026-11-24T13:00:00Z", end: "2026-11-24T13:30:00Z" }]);
  assert.equal(result.answers[0].available, false);
  assert.ok(result.suggestions.length >= 1 && result.suggestions.length <= 2);
  for (const s of result.suggestions) assert.equal(isFree(people[0], evs[0], [], T(s.start), T(s.end)), true);
});

test("validation: too many windows, past, off-grid", () => {
  const state = { receipts: [], requests: [] };
  const q = (ws) => answerQuestion({ profile: people[1], events: evs[1], state, now: NOW }, ws).result;
  assert.match(q(Array.from({ length: 7 }, (_, i) => ({ start: `2026-11-23T1${i}:00:00Z`, end: `2026-11-23T1${i}:30:00Z` }))).reason, /at most 6/);
  assert.match(q([{ start: "2026-11-20T10:00:00Z", end: "2026-11-20T10:30:00Z" }]).reason, /already started/);
  assert.match(q([{ start: "2026-11-23T10:05:00Z", end: "2026-11-23T10:35:00Z" }]).reason, /quarter hour/);
});

test("server: request, owner decides, accepted time blocks later answers", async () => {
  const srv = new OwnerServer({ profile: people[2], store: new MemoryStore(), ownerKey: "k", now: () => NOW });
  const body = { start: "2026-11-26T14:30:00Z", end: "2026-11-26T15:00:00Z", title: "Paper sync", from_name: "Ana", from_email: "ana@example.com", caller_origin: "https://ana.example" };
  const r = (await srv.handle({ method: "POST", path: "/api/request", body })).body;
  assert.equal(r.ok, true); assert.match(r.reference, /^OV-/);
  assert.equal((await srv.handle({ method: "GET", path: "/api/owner/overview", headers: {} })).status, 401);
  const d = (await srv.handle({ method: "POST", path: "/api/owner/decide", headers: { authorization: "Bearer k" }, body: { ref: r.reference, decision: "accepted" } })).body;
  assert.equal(d.status, "accepted");
  const c = (await srv.handle({ method: "POST", path: "/api/check", body: { windows: [{ start: body.start, end: body.end }], caller_origin: "https://bo.example" } })).body;
  assert.equal(c.answers[0].available, false);
  const ov = (await srv.handle({ method: "GET", path: "/api/owner/overview", headers: { authorization: "Bearer k" } })).body;
  assert.equal(ov.receipts.length, 2);
  const prof = (await srv.handle({ method: "GET", path: "/api/profile" })).body;
  assert.equal("working_hours" in prof || "calendar" in prof || "dev_owner_key" in prof, false);
});

test("owner free blocks", () => {
  const blocks = ownerFreeWindows(people[0], evs[0], { requests: [] }, T("2026-11-26T00:00:00Z"), T("2026-11-27T00:00:00Z"), 30, NOW);
  assert.ok(blocks.some((b) => T(b.start) <= T("2026-11-26T14:30:00Z") && T(b.end) >= T("2026-11-26T15:00:00Z")));
});

test("accepted request yields a standard .ics invite and the owner's feed", async () => {
  const srv = new OwnerServer({ profile: people[1], store: new MemoryStore(), ownerKey: "k", now: () => NOW });
  const r = (await srv.handle({ method: "POST", path: "/api/request", body: { start: "2026-11-26T14:30:00Z", end: "2026-11-26T15:00:00Z", title: "Pricing, sync", from_name: "Ana", from_email: "ana@example.com", caller_origin: "https://ana.example" } })).body;
  assert.equal((await srv.handle({ method: "GET", path: "/api/invite.ics", query: { ref: r.reference } })).status, 404, "no invite before acceptance");
  await srv.handle({ method: "POST", path: "/api/owner/decide", headers: { authorization: "Bearer k" }, body: { ref: r.reference, decision: "accepted" } });
  const inv = await srv.handle({ method: "GET", path: "/api/invite.ics", query: { ref: r.reference } });
  assert.match(inv.ics, /BEGIN:VEVENT[\s\S]*DTSTART:20261126T143000Z[\s\S]*SUMMARY:Pricing\\, sync[\s\S]*END:VCALENDAR/);
  const st = (await srv.handle({ method: "GET", path: "/api/request-status", query: { ref: r.reference } })).body;
  assert.equal(st.invite, `/api/invite.ics?ref=${r.reference}`);
  const ov = (await srv.handle({ method: "GET", path: "/api/owner/overview", headers: { authorization: "Bearer k" } })).body;
  const token = new URL(ov.calendar_feed, "http://x").searchParams.get("token");
  assert.match((await srv.handle({ method: "GET", path: "/api/calendar.ics", query: { token } })).ics, /UID:OV-/);
  assert.equal((await srv.handle({ method: "GET", path: "/api/calendar.ics", query: { token: "wrong" } })).status, 404);
});

test("a caller that changes its claimed origin is still held by its network address", async () => {
  const srv = new OwnerServer({ profile: people[1], store: new MemoryStore(), ownerKey: "k", now: () => NOW });
  const ask = (origin, ip, day) => srv.handle({ method: "POST", path: "/api/check", ip, body: { caller_origin: origin,
    windows: Array.from({ length: 6 }, (_, i) => ({ start: `2026-11-${day}T1${i}:00:00Z`, end: `2026-11-${day}T1${i}:30:00Z` })) } });
  for (const [o, d] of [["https://a.example", 23], ["https://b.example", 24]]) assert.equal((await ask(o, "203.0.113.9", d)).body.ok, true);
  assert.equal((await ask("https://d.example", "203.0.113.9", 26)).body.ok, false, "3rd unverified question from the same address is refused");
  assert.equal((await ask("https://e.example", "198.51.100.7", 26)).body.ok, true, "another address still gets answers");
});

test("an unsigned requester must give an email", async () => {
  const srv = new OwnerServer({ profile: people[1], store: new MemoryStore(), ownerKey: "k", now: () => NOW });
  const base = { start: "2026-11-26T14:30:00Z", end: "2026-11-26T15:00:00Z", title: "Sync", from_name: "Ana", caller_origin: "https://ana.example" };
  assert.match((await srv.handle({ method: "POST", path: "/api/request", body: base })).body.reason, /valid email/);
  assert.match((await srv.handle({ method: "POST", path: "/api/request", body: { ...base, from_page: "https://ana.example" } })).body.reason, /valid email/, "a claimed page is not enough; it must be signed");
});

test("hosted pages: create from an iCal address, own key, own path, delete", async () => {
  const { HostedPages } = await import("../core/hosted.mjs");
  const store = () => new MemoryStore();
  const stores = {};
  const hp = new HostedPages({ registry: new MemoryStore(), storeFor: (id) => (stores[id] ||= store()), now: () => NOW,
    fetchIcs: async (url) => { if (!url.endsWith(".ics")) throw new Error("HTTP 404"); return readFileSync(new URL("../personas/bo.ics", import.meta.url), "utf8"); } });
  const O = "https://overlap.example";
  assert.match((await hp.handle({ method: "POST", path: "/api/pages", body: { name: "Bo", timezone: "Europe/London", ics_url: "https://x/nope" }, origin: O })).body.reason, /Could not read/);
  const c = (await hp.handle({ method: "POST", path: "/api/pages", body: { name: "Bo Okafor", timezone: "Europe/London", ics_url: "https://cal.example/bo.ics", from: "08:30", to: "16:30", days: ["mon", "tue", "wed", "thu"] }, origin: O })).body;
  assert.equal(c.ok, true); assert.match(c.page_url, /^https:\/\/overlap\.example\/u\/bo-okafor-[0-9a-f]{4}\/$/);
  const id = c.id;
  const key = (await hp.handle({ method: "GET", path: `/u/${id}/api/key`, origin: O })).body;
  assert.equal(key.page, `${O}/u/${id}`);
  const ans = (await hp.handle({ method: "POST", path: `/u/${id}/api/check`, ip: "1.1.1.1", origin: O, body: { caller_origin: O, windows: [{ start: "2026-11-26T14:00:00Z", end: "2026-11-26T14:30:00Z" }, { start: "2026-11-26T14:30:00Z", end: "2026-11-26T15:00:00Z" }] } })).body;
  assert.deepEqual(ans.answers.map((a) => a.available), [false, true]);
  const prof = (await hp.handle({ method: "GET", path: `/u/${id}/api/profile`, origin: O })).body;
  assert.equal(JSON.stringify(prof).includes("cal.example"), false, "the calendar address is never published");
  assert.equal((await hp.handle({ method: "POST", path: `/u/${id}/api/owner/delete`, headers: { authorization: "Bearer wrong" }, origin: O })).status, 401);
  assert.equal((await hp.handle({ method: "POST", path: `/u/${id}/api/owner/delete`, headers: { authorization: `Bearer ${c.owner_key}` }, origin: O })).body.ok, true);
  assert.equal((await hp.handle({ method: "GET", path: `/u/${id}/api/profile`, origin: O })).status, 404);
});

test("hosted pages refuse calendar addresses on private networks", async () => {
  const { defaultFetchIcs } = await import("../core/hosted.mjs");
  await assert.rejects(defaultFetchIcs("http://example.com/a.ics"), /https/);
  await assert.rejects(defaultFetchIcs("https://127.0.0.1/a.ics"), /private/);
  await assert.rejects(defaultFetchIcs("https://10.1.2.3/a.ics"), /private/);
});

test("a prober using many signed pages over many days learns at most the weekly cap about a week", () => {
  const profile = { ...people[1], budget: { per_week_total: 40 } };
  const state = { receipts: [], requests: [] };
  const slots = [];
  for (let d = 23; d <= 27; d++) for (let h = 9; h < 17; h++) for (const m of ["00", "30"]) slots.push(`2026-11-${d}T${String(h).padStart(2, "0")}:${m}:00Z`);
  let learned = 0, day = 0;
  for (let page = 0; page < 40 && slots.length; page++) {
    const ws = slots.splice(0, 6).map((s) => ({ start: s, end: new Date(Date.parse(s) + 1800000).toISOString() }));
    const out = answerQuestion({ profile, events: evs[1], state, callerOrigin: `https://p${page}.example`, verifiedPage: `https://p${page}.example`, now: NOW - 4 * 86400000 + (day++ % 4) * 86400000 }, ws);
    if (out.receipt) state.receipts.push(out.receipt);
    if (out.result.ok) learned += out.result.answers.length;
  }
  assert.ok(learned <= 40, `learned ${learned} of 80`);
  state.grants = { "https://trusted.example": { per_day: 36, trusted: true } };
  const t = answerQuestion({ profile, events: evs[1], state, verifiedPage: "https://trusted.example", now: NOW }, [{ start: "2026-11-26T14:30:00Z", end: "2026-11-26T15:00:00Z" }]);
  assert.equal(t.result.ok, true, "a trusted page is not held by the weekly cap");
});

test("hosted pages from busy times only: no titles reach the host, owner can refresh", async () => {
  const { HostedPages, busyToIcs } = await import("../core/hosted.mjs");
  const stores = {};
  const registry = new MemoryStore();
  const hp = new HostedPages({ registry, storeFor: (id) => (stores[id] ||= new MemoryStore()), now: () => NOW, fetchIcs: async () => { throw new Error("must not fetch"); } });
  const busy = busyIntervals(evs[1], NOW, NOW + 14 * 864e5);
  const c = (await hp.handle({ method: "POST", path: "/api/pages", origin: "https://h.example", body: { name: "Bo", timezone: "Europe/London", busy, from: "08:30", to: "16:30", days: ["mon", "tue", "wed", "thu"] } })).body;
  assert.equal(c.ok, true);
  const reg = await registry.load();
  assert.equal(JSON.stringify(reg).includes("Board prep"), false, "no titles stored");
  assert.equal("ics_url" in reg.pages[c.id], false);
  const ans = (await hp.handle({ method: "POST", path: `/u/${c.id}/api/check`, origin: "https://h.example", ip: "9.9.9.9", body: { windows: [{ start: "2026-11-26T14:00:00Z", end: "2026-11-26T14:30:00Z" }, { start: "2026-11-26T14:30:00Z", end: "2026-11-26T15:00:00Z" }] } })).body;
  assert.deepEqual(ans.answers.map((a) => a.available), [false, true]);
  const up = (await hp.handle({ method: "POST", path: `/u/${c.id}/api/owner/busy`, origin: "https://h.example", headers: { authorization: `Bearer ${c.owner_key}` }, body: { busy: [[Date.parse("2026-11-26T14:30:00Z"), Date.parse("2026-11-26T15:00:00Z")]] } })).body;
  assert.equal(up.ok, true);
  const ans2 = (await hp.handle({ method: "POST", path: `/u/${c.id}/api/check`, origin: "https://h.example", ip: "9.9.9.8", body: { windows: [{ start: "2026-11-26T14:30:00Z", end: "2026-11-26T15:00:00Z" }] } })).body;
  assert.equal(ans2.answers[0].available, false, "refreshed busy times apply");
  assert.match(busyToIcs([[0, 60000]]), /DTSTART:19700101T000000Z/);
});
