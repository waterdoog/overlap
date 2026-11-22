
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OwnerServer, toIcs, toCancelIcs } from "../core/api.mjs";
import { MemoryStore } from "../core/store.mjs";

const load = (id) => {
  const p = JSON.parse(readFileSync(new URL(`../personas/${id}.json`, import.meta.url)));
  p.calendar = { ics: readFileSync(new URL(`../personas/${id}.ics`, import.meta.url), "utf8") };
  return p;
};
// Sunday 22 Nov 2026 00:00 UTC; Thursday 26 Nov 14:30 UTC is free for all personas.
const NOW = Date.parse("2026-11-22T00:00:00Z");
const people = ["ana", "bo", "cy"].map(load);

test("1. instant booking for trusted pages when auto_accept_trusted is enabled", async () => {
  let boIcs = people[1].calendar.ics;
  const ana = new OwnerServer({ profile: people[0], store: new MemoryStore(), ownerKey: "ka", now: () => NOW });
  const keys = { "https://ana.example": (await ana.handle({ method: "GET", path: "/api/key", base: "https://ana.example" })).body };
  const bo = new OwnerServer({
    profile: people[1], store: new MemoryStore(), ownerKey: "kb", now: () => NOW,
    fetchKey: async (iss) => keys[iss], loadCalendar: async () => boIcs,
  });
  const BO = "https://bo.example";
  const sign = async () => (await ana.handle({
    method: "POST", path: "/api/owner/assertion", headers: { authorization: "Bearer ka" }, body: { aud: BO }, base: "https://ana.example",
  })).body.assertion;

  // Mark Ana's page trusted, keep auto_accept_trusted default (false) -> stays pending
  await bo.handle({ method: "POST", path: "/api/owner/grant", headers: { authorization: "Bearer kb" }, base: BO, body: { page: "https://ana.example", per_day: 36, trusted: true } });
  const rPending = (await bo.handle({
    method: "POST", path: "/api/request", base: BO,
    body: { start: "2026-11-26T14:30:00Z", end: "2026-11-26T15:00:00Z", title: "First sync", from_name: "Ana", caller_origin: "https://ana.example", assertion: await sign() },
  })).body;
  assert.equal(rPending.ok, true);
  assert.equal(rPending.status, "pending");

  // Cancel that pending request so slot is free again, then turn on auto_accept_trusted
  await bo.handle({ method: "POST", path: "/api/owner/cancel", headers: { authorization: "Bearer kb" }, body: { ref: rPending.reference } });
  const setRes = (await bo.handle({ method: "POST", path: "/api/owner/settings", headers: { authorization: "Bearer kb" }, body: { auto_accept_trusted: true } })).body;
  assert.equal(setRes.ok, true);
  assert.equal(setRes.settings.auto_accept_trusted, true);

  // Untrusted / unsigned caller still lands as pending even when auto_accept_trusted is true
  const rUntrusted = (await bo.handle({
    method: "POST", path: "/api/request", base: BO,
    body: { start: "2026-11-26T15:00:00Z", end: "2026-11-26T15:30:00Z", title: "Cold intro", from_name: "Eve", from_email: "eve@example.com", caller_origin: "https://eve.example" },
  })).body;
  assert.equal(rUntrusted.status, "pending");

  // Trusted caller with verified assertion gets instant acceptance + invite + calendar links
  const rInstant = (await bo.handle({
    method: "POST", path: "/api/request", base: BO,
    body: { start: "2026-11-26T14:30:00Z", end: "2026-11-26T15:00:00Z", title: "Trusted sync", from_name: "Ana", caller_origin: "https://ana.example", assertion: await sign() },
  })).body;
  assert.equal(rInstant.ok, true);
  assert.equal(rInstant.status, "accepted");
  assert.equal(rInstant.invite, `/api/invite.ics?ref=${rInstant.reference}`);
  assert.match(rInstant.google_calendar, /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/);
  assert.match(rInstant.outlook_calendar, /^https:\/\/outlook\.live\.com\/calendar\/0\/deeplink\/compose\?/);

  const ov = (await bo.handle({ method: "GET", path: "/api/owner/overview", headers: { authorization: "Bearer kb" } })).body;
  const stored = ov.requests.find((x) => x.ref === rInstant.reference);
  assert.equal(stored.status, "accepted");
  assert.equal(stored.decided, NOW);

  // Fresh calendar conflict re-check: newly added busy block prevents instant booking even if cached earlier
  await bo.handle({ method: "POST", path: "/api/owner/cancel", headers: { authorization: "Bearer kb" }, body: { ref: rInstant.reference } });
  boIcs = boIcs.replace("END:VCALENDAR", "BEGIN:VEVENT\nUID: sudden\nDTSTART:20261126T143000Z\nDTEND:20261126T150000Z\nSUMMARY:Emergency\nEND:VEVENT\nEND:VCALENDAR");
  const rConflict = (await bo.handle({
    method: "POST", path: "/api/request", base: BO,
    body: { start: "2026-11-26T14:30:00Z", end: "2026-11-26T15:00:00Z", title: "Retry", from_name: "Ana", caller_origin: "https://ana.example", assertion: await sign() },
  })).body;
  assert.equal(rConflict.ok, false);
});

test("2. cancel by owner and requester, token secrecy, CANCEL ics, feed status, and freeing time", async () => {
  const srv = new OwnerServer({ profile: people[1], store: new MemoryStore(), ownerKey: "k", now: () => NOW });
  const slot = { start: "2026-11-26T14:30:00Z", end: "2026-11-26T15:00:00Z" };

  // Request 1: accepted, then cancelled by requester using cancel_token
  const r1 = (await srv.handle({
    method: "POST", path: "/api/request",
    body: { ...slot, title: "Design review", from_name: "Ana", from_email: "ana@example.com", caller_origin: "https://ana.example" },
  })).body;
  assert.equal(r1.ok, true);
  assert.equal(typeof r1.cancel_token, "string");
  assert.equal(Buffer.from(r1.cancel_token, "base64url").length, 16);

  // cancel_token must NOT appear in request-status or owner overview
  const stBefore = (await srv.handle({ method: "GET", path: "/api/request-status", query: { ref: r1.reference } })).body;
  assert.equal("cancel_token" in stBefore, false);
  const ovBefore = (await srv.handle({ method: "GET", path: "/api/owner/overview", headers: { authorization: "Bearer k" } })).body;
  assert.equal(JSON.stringify(ovBefore).includes(r1.cancel_token), false);

  await srv.handle({ method: "POST", path: "/api/owner/decide", headers: { authorization: "Bearer k" }, body: { ref: r1.reference, decision: "accepted" } });

  // Wrong token fails
  assert.equal((await srv.handle({ method: "POST", path: "/api/cancel", body: { ref: r1.reference, cancel_token: "wrong-token-value-1234" } })).body.ok, false);
  assert.equal((await srv.handle({ method: "POST", path: "/api/cancel", body: { ref: r1.reference, cancel_token: "short" } })).body.ok, false);

  // Valid token cancels
  const c1 = (await srv.handle({ method: "POST", path: "/api/cancel", body: { ref: r1.reference, cancel_token: r1.cancel_token } })).body;
  assert.equal(c1.ok, true);
  assert.equal(c1.status, "cancelled");

  // GET /api/request-status reports cancelled
  const stAfter = (await srv.handle({ method: "GET", path: "/api/request-status", query: { ref: r1.reference } })).body;
  assert.equal(stAfter.status, "cancelled");
  assert.equal("invite" in stAfter, false);

  // GET /api/invite.ics returns METHOD:CANCEL, STATUS:CANCELLED, SEQUENCE:1, same UID
  const invCancel = await srv.handle({ method: "GET", path: "/api/invite.ics", query: { ref: r1.reference } });
  assert.equal(invCancel.status, 200);
  assert.match(invCancel.ics, /METHOD:CANCEL/);
  assert.match(invCancel.ics, /STATUS:CANCELLED/);
  assert.match(invCancel.ics, /SEQUENCE:1/);
  assert.match(invCancel.ics, new RegExp(`UID:${r1.reference}@overlap`));

  // Owner feed includes cancelled request as STATUS:CANCELLED
  const token = new URL(ovBefore.calendar_feed, "http://x").searchParams.get("token");
  const feedIcs = (await srv.handle({ method: "GET", path: "/api/calendar.ics", query: { token } })).ics;
  assert.match(feedIcs, new RegExp(`UID:${r1.reference}@overlap[\\s\\S]*?STATUS:CANCELLED`));

  // Cancelled request no longer blocks availability
  const chk = (await srv.handle({ method: "POST", path: "/api/check", body: { windows: [slot], caller_origin: "https://cy.example" } })).body;
  assert.equal(chk.answers[0].available, true);

  // Request 2: cancelled by owner via POST /api/owner/cancel
  const r2 = (await srv.handle({
    method: "POST", path: "/api/request",
    body: { ...slot, title: "Follow up", from_name: "Cy", from_email: "cy@example.com", caller_origin: "https://cy.example" },
  })).body;
  assert.equal((await srv.handle({ method: "POST", path: "/api/owner/cancel", body: { ref: r2.reference } })).status, 401);
  const c2 = (await srv.handle({ method: "POST", path: "/api/owner/cancel", headers: { authorization: "Bearer k" }, body: { ref: r2.reference } })).body;
  assert.equal(c2.ok, true);
  assert.equal(c2.status, "cancelled");
  const ovAfter = (await srv.handle({ method: "GET", path: "/api/owner/overview", headers: { authorization: "Bearer k" } })).body;
  const r2Stored = ovAfter.requests.find((x) => x.ref === r2.reference);
  assert.equal(r2Stored.by, "owner");
  assert.equal(r2Stored.cancelled, NOW);
});

test("3. minimum notice: settings validation, check answers not free, request refused with clear reason", async () => {
  // Monday 23 Nov 2026 09:00 UTC. Bo works Mon 08:30-16:30 Europe/London (UTC in Nov).
  const MON_MORNING = Date.parse("2026-11-23T09:00:00Z");
  const srv = new OwnerServer({ profile: people[1], store: new MemoryStore(), ownerKey: "k", now: () => MON_MORNING });

  const soonSlot = { start: "2026-11-23T11:30:00Z", end: "2026-11-23T12:00:00Z" }; // +2.5h
  const laterSlot = { start: "2026-11-26T14:30:00Z", end: "2026-11-26T15:00:00Z" }; // +77.5h

  // Default min_notice_hours is 0 -> soonSlot is free (confirm baseline)
  const baseChk = (await srv.handle({ method: "POST", path: "/api/check", ip: "1.1.1.1", body: { windows: [soonSlot, laterSlot], caller_origin: "https://ana.example" } })).body;
  assert.deepEqual(baseChk.answers.map((a) => a.available), [true, true]);

  // Bounds validation: <0 or >168 rejected
  assert.equal((await srv.handle({ method: "POST", path: "/api/owner/settings", headers: { authorization: "Bearer k" }, body: { min_notice_hours: -1 } })).body.ok, false);
  assert.equal((await srv.handle({ method: "POST", path: "/api/owner/settings", headers: { authorization: "Bearer k" }, body: { min_notice_hours: 200 } })).body.ok, false);

  // Set min_notice_hours to 24
  const sOk = (await srv.handle({ method: "POST", path: "/api/owner/settings", headers: { authorization: "Bearer k" }, body: { min_notice_hours: 24 } })).body;
  assert.equal(sOk.ok, true);
  assert.equal(sOk.settings.min_notice_hours, 24);

  // Check now reports soonSlot as not free, laterSlot still free
  const chk = (await srv.handle({ method: "POST", path: "/api/check", ip: "1.1.1.2", body: { windows: [soonSlot, laterSlot], caller_origin: "https://bo.example" } })).body;
  assert.deepEqual(chk.answers.map((a) => a.available), [false, true]);

  // Request inside notice window is refused with a clear reason mentioning notice
  const reqRefused = (await srv.handle({
    method: "POST", path: "/api/request",
    body: { ...soonSlot, title: "Quick chat", from_name: "Ana", from_email: "ana@example.com", caller_origin: "https://ana.example" },
  })).body;
  assert.equal(reqRefused.ok, false);
  assert.match(reqRefused.reason, /24 hours of notice/);
});

test("4. tentative holds: pending requests from verified callers block other askers, not owner view or max_meetings_per_day", async () => {
  const ana = new OwnerServer({ profile: people[0], store: new MemoryStore(), ownerKey: "ka", now: () => NOW });
  const keys = { "https://ana.example": (await ana.handle({ method: "GET", path: "/api/key", base: "https://ana.example" })).body };
  const profileWithCap = { ...people[1], max_meetings_per_day: 3 };
  const srv = new OwnerServer({
    profile: profileWithCap, store: new MemoryStore(), ownerKey: "k", now: () => NOW,
    fetchKey: async (iss) => keys[iss],
  });
  const BO = "https://bo.example";
  const signAna = async () => (await ana.handle({
    method: "POST", path: "/api/owner/assertion", headers: { authorization: "Bearer ka" }, body: { aud: BO }, base: "https://ana.example",
  })).body.assertion;

  const slotA = { start: "2026-11-26T14:30:00Z", end: "2026-11-26T15:00:00Z" };
  const slotB = { start: "2026-11-26T15:00:00Z", end: "2026-11-26T15:30:00Z" };

  // Verified Ana places a pending request on slotA
  const rAna = (await srv.handle({
    method: "POST", path: "/api/request", base: BO,
    body: { ...slotA, title: "Hold test", from_name: "Ana", caller_origin: "https://ana.example", assertion: await signAna() },
  })).body;
  assert.equal(rAna.ok, true);
  assert.equal(rAna.status, "pending");

  // Default hold_pending is true: Cy (another asker) sees slotA as NOT free, but slotB IS free (pending did not consume max_meetings_per_day)
  const cyCheck = (await srv.handle({
    method: "POST", path: "/api/check", base: BO, ip: "2.2.2.2",
    body: { windows: [slotA, slotB], caller_origin: "https://cy.example" },
  })).body;
  assert.deepEqual(cyCheck.answers.map((a) => a.available), [false, true]);

  // Cy also cannot book slotA while held
  const cyReq = (await srv.handle({
    method: "POST", path: "/api/request", base: BO,
    body: { ...slotA, title: "Collide", from_name: "Cy", from_email: "cy@example.com", caller_origin: "https://cy.example" },
  })).body;
  assert.equal(cyReq.ok, false);

  // Owner's own free view still sees slotA as free
  const ownFree = (await srv.handle({
    method: "GET", path: "/api/owner/free", headers: { authorization: "Bearer k" },
    query: { from: "2026-11-26T14:00:00Z", to: "2026-11-26T16:00:00Z", minutes: "30" },
  })).body;
  assert.ok(ownFree.free.some((b) => Date.parse(b.start) <= Date.parse(slotA.start) && Date.parse(b.end) >= Date.parse(slotA.end)));

  // Turning hold_pending off lets Cy see slotA as free again
  await srv.handle({ method: "POST", path: "/api/owner/settings", headers: { authorization: "Bearer k" }, body: { hold_pending: false } });
  const cyCheck2 = (await srv.handle({
    method: "POST", path: "/api/check", base: BO, ip: "2.2.2.3",
    body: { windows: [slotA], caller_origin: "https://cy.example" },
  })).body;
  assert.equal(cyCheck2.answers[0].available, true);
});

test("5. add-to-calendar links (Google & Outlook) are properly URL-encoded on status and overview", async () => {
  const srv = new OwnerServer({ profile: people[1], store: new MemoryStore(), ownerKey: "k", now: () => NOW });
  const r = (await srv.handle({
    method: "POST", path: "/api/request",
    body: {
      start: "2026-11-26T14:30:00Z", end: "2026-11-26T15:00:00Z",
      title: "Q1 R&D + Budget?", from_name: "Ana Silva", from_email: "ana@example.com",
      note: "Bring slides & numbers", caller_origin: "https://ana.example",
    },
  })).body;
  assert.equal(r.ok, true);

  // Before acceptance: no calendar links on status
  const stPending = (await srv.handle({ method: "GET", path: "/api/request-status", query: { ref: r.reference } })).body;
  assert.equal("google_calendar" in stPending, false);
  assert.equal("outlook_calendar" in stPending, false);

  await srv.handle({ method: "POST", path: "/api/owner/decide", headers: { authorization: "Bearer k" }, body: { ref: r.reference, decision: "accepted" } });

  const st = (await srv.handle({ method: "GET", path: "/api/request-status", query: { ref: r.reference } })).body;
  assert.equal(st.status, "accepted");
  assert.equal(st.invite, `/api/invite.ics?ref=${r.reference}`);

  const gUrl = new URL(st.google_calendar);
  assert.equal(gUrl.origin + gUrl.pathname, "https://calendar.google.com/calendar/render");
  assert.equal(gUrl.searchParams.get("action"), "TEMPLATE");
  assert.equal(gUrl.searchParams.get("text"), "Q1 R&D + Budget?");
  assert.equal(gUrl.searchParams.get("dates"), "20261126T143000Z/20261126T150000Z");
  assert.match(gUrl.searchParams.get("details"), /Bring slides & numbers/);

  const oUrl = new URL(st.outlook_calendar);
  assert.equal(oUrl.origin + oUrl.pathname, "https://outlook.live.com/calendar/0/deeplink/compose");
  assert.equal(oUrl.searchParams.get("subject"), "Q1 R&D + Budget?");
  assert.equal(oUrl.searchParams.get("startdt"), "2026-11-26T14:30:00.000Z");
  assert.equal(oUrl.searchParams.get("enddt"), "2026-11-26T15:00:00.000Z");

  // Owner overview also includes the add-to-calendar links on accepted requests
  const ov = (await srv.handle({ method: "GET", path: "/api/owner/overview", headers: { authorization: "Bearer k" } })).body;
  const reqInOv = ov.requests.find((x) => x.ref === r.reference);
  assert.equal(reqInOv.google_calendar, st.google_calendar);
  assert.equal(reqInOv.outlook_calendar, st.outlook_calendar);
});

test("6. iCalendar injection prevention: CR/LF and special chars escaped or stripped in .ics output", async () => {
  const srv = new OwnerServer({ profile: people[1], store: new MemoryStore(), ownerKey: "k", now: () => NOW });
  const r = (await srv.handle({
    method: "POST", path: "/api/request",
    body: {
      start: "2026-11-26T14:30:00Z", end: "2026-11-26T15:00:00Z",
      title: "Hello; World, \\test\r\nATTENDEE:mailto:evil@example.com",
      from_name: "Mallory\r\nBEGIN:VALARM, ; \\ :",
      from_email: "mal@example.com",
      note: "Line1\rLine2\r\nBEGIN:VEVENT",
      caller_origin: "https://mal.example",
    },
  })).body;
  assert.equal(r.ok, true);
  await srv.handle({ method: "POST", path: "/api/owner/decide", headers: { authorization: "Bearer k" }, body: { ref: r.reference, decision: "accepted" } });

  const inv = await srv.handle({ method: "GET", path: "/api/invite.ics", query: { ref: r.reference } });
  assert.equal(inv.status, 200);
  const lines = inv.ics.trim().split("\r\n");
  for (const line of lines) {
    assert.equal(line.includes("\r"), false);
    assert.equal(line.includes("\n"), false);
  }
  assert.equal(lines.filter((l) => l.startsWith("ATTENDEE")).length, 1);
  assert.equal(lines.filter((l) => l === "BEGIN:VEVENT").length, 1);
  assert.equal(lines.some((l) => l.startsWith("BEGIN:VALARM")), false);
  assert.match(inv.ics, /SUMMARY:Hello\\; World\\, \\\\test\\nATTENDEE:mailto:evil@example\.com/);

  // Direct unit check on toIcs and toCancelIcs with CR/LF in email and URL
  const rawReq = {
    ref: "OV-123456", status: "accepted", created: NOW, decided: NOW,
    start: "2026-11-26T14:30:00Z", end: "2026-11-26T15:00:00Z",
    title: "T\r\nX:1", from_name: "N\r\nY:2",
    from_email: "a@b.c\r\nSUMMARY:Injected", from_page: "https://p.example\r\nURL:https://evil.example",
    note: "n\r\nm",
  };
  for (const ics of [toIcs([rawReq], people[1], "Cal\r\nX:1"), toCancelIcs({ ...rawReq, status: "cancelled" }, people[1], "Cal\r\nX:1")]) {
    const ls = ics.trim().split("\r\n");
    assert.equal(ls.some((l) => l.includes("\r") || l.includes("\n")), false);
    assert.equal(ls.some((l) => l === "SUMMARY:Injected"), false);
    assert.equal(ls.some((l) => l.startsWith("URL:https://evil.example")), false);
    assert.equal(ls.some((l) => l === "X:1" || l === "Y:2"), false);
  }
});

test("7. tentative holds apply only to verified callers and self-exemption requires verification", async () => {
  const ana = new OwnerServer({ profile: people[0], store: new MemoryStore(), ownerKey: "ka", now: () => NOW });
  const cy = new OwnerServer({ profile: people[2], store: new MemoryStore(), ownerKey: "kc", now: () => NOW });
  const keys = {
    "https://ana.example": (await ana.handle({ method: "GET", path: "/api/key", base: "https://ana.example" })).body,
    "https://cy.example": (await cy.handle({ method: "GET", path: "/api/key", base: "https://cy.example" })).body,
  };
  const bo = new OwnerServer({
    profile: people[1], store: new MemoryStore(), ownerKey: "kb", now: () => NOW,
    fetchKey: async (iss) => keys[iss],
  });
  const BO = "https://bo.example";
  const signAna = async () => (await ana.handle({
    method: "POST", path: "/api/owner/assertion", headers: { authorization: "Bearer ka" }, body: { aud: BO }, base: "https://ana.example",
  })).body.assertion;
  const signCy = async () => (await cy.handle({
    method: "POST", path: "/api/owner/assertion", headers: { authorization: "Bearer kc" }, body: { aud: BO }, base: "https://cy.example",
  })).body.assertion;

  const slot = { start: "2026-11-26T14:30:00Z", end: "2026-11-26T15:00:00Z" };

  // Unverified caller makes a pending request -> does NOT hold time for anyone
  const rUnverified = (await bo.handle({
    method: "POST", path: "/api/request", base: BO,
    body: { ...slot, title: "Spam hold?", from_name: "Mallory", from_email: "mal@example.com", caller_origin: "https://mal.example" },
  })).body;
  assert.equal(rUnverified.ok, true);
  assert.equal(rUnverified.status, "pending");

  const checkAfterUnverified = (await bo.handle({
    method: "POST", path: "/api/check", base: BO, ip: "3.3.3.3",
    body: { windows: [slot], caller_origin: "https://other.example" },
  })).body;
  assert.equal(checkAfterUnverified.answers[0].available, true);

  // Verified Ana makes a pending request -> holds time for others
  const rVerified = (await bo.handle({
    method: "POST", path: "/api/request", base: BO,
    body: { ...slot, title: "Real hold", from_name: "Ana", caller_origin: "https://ana.example", assertion: await signAna() },
  })).body;
  assert.equal(rVerified.ok, true);
  assert.equal(rVerified.status, "pending");

  // Verified Cy sees slot as busy
  const cyCheck = (await bo.handle({
    method: "POST", path: "/api/check", base: BO,
    body: { windows: [slot], caller_origin: "https://cy.example", assertion: await signCy() },
  })).body;
  assert.equal(cyCheck.answers[0].available, false);

  // Unsigned client spoofing caller_origin "https://ana.example" does NOT get Ana's self-exemption
  const spoofCheck = (await bo.handle({
    method: "POST", path: "/api/check", base: BO, ip: "4.4.4.4",
    body: { windows: [slot], caller_origin: "https://ana.example" },
  })).body;
  assert.equal(spoofCheck.answers[0].available, false);

  // Verified Ana DOES get self-exemption and still sees her own pending slot as available
  const anaCheck = (await bo.handle({
    method: "POST", path: "/api/check", base: BO,
    body: { windows: [slot], caller_origin: "https://ana.example", assertion: await signAna() },
  })).body;
  assert.equal(anaCheck.answers[0].available, true);
});

test("8. pending request cancelled before acceptance is excluded from invite.ics and owner feed", async () => {
  const srv = new OwnerServer({ profile: people[1], store: new MemoryStore(), ownerKey: "k", now: () => NOW });
  const slot1 = { start: "2026-11-26T14:30:00Z", end: "2026-11-26T15:00:00Z" };
  const slot2 = { start: "2026-11-26T15:00:00Z", end: "2026-11-26T15:30:00Z" };

  // Pending request cancelled by requester (never accepted)
  const rPendingReqCancel = (await srv.handle({
    method: "POST", path: "/api/request",
    body: { ...slot1, title: "Never accepted 1", from_name: "Ana", from_email: "ana@example.com", caller_origin: "https://ana.example" },
  })).body;
  await srv.handle({ method: "POST", path: "/api/cancel", body: { ref: rPendingReqCancel.reference, cancel_token: rPendingReqCancel.cancel_token } });

  // Pending request cancelled by owner (never accepted)
  const rPendingOwnCancel = (await srv.handle({
    method: "POST", path: "/api/request",
    body: { ...slot1, title: "Never accepted 2", from_name: "Cy", from_email: "cy@example.com", caller_origin: "https://cy.example" },
  })).body;
  await srv.handle({ method: "POST", path: "/api/owner/cancel", headers: { authorization: "Bearer k" }, body: { ref: rPendingOwnCancel.reference } });

  // Accepted request then cancelled
  const rAcceptedCancel = (await srv.handle({
    method: "POST", path: "/api/request",
    body: { ...slot2, title: "Accepted then cancelled", from_name: "Bo", from_email: "bo@example.com", caller_origin: "https://bo.example" },
  })).body;
  await srv.handle({ method: "POST", path: "/api/owner/decide", headers: { authorization: "Bearer k" }, body: { ref: rAcceptedCancel.reference, decision: "accepted" } });
  await srv.handle({ method: "POST", path: "/api/owner/cancel", headers: { authorization: "Bearer k" }, body: { ref: rAcceptedCancel.reference } });

  // invite.ics returns 404 for both never-accepted cancelled requests
  const inv1 = await srv.handle({ method: "GET", path: "/api/invite.ics", query: { ref: rPendingReqCancel.reference } });
  assert.equal(inv1.status, 404);
  const inv2 = await srv.handle({ method: "GET", path: "/api/invite.ics", query: { ref: rPendingOwnCancel.reference } });
  assert.equal(inv2.status, 404);

  // invite.ics returns 200 METHOD:CANCEL / STATUS:CANCELLED for accepted-then-cancelled
  const inv3 = await srv.handle({ method: "GET", path: "/api/invite.ics", query: { ref: rAcceptedCancel.reference } });
  assert.equal(inv3.status, 200);
  assert.match(inv3.ics, /METHOD:CANCEL/);
  assert.match(inv3.ics, /STATUS:CANCELLED/);

  // Owner feed omits never-accepted cancelled requests, includes accepted-then-cancelled
  const ov = (await srv.handle({ method: "GET", path: "/api/owner/overview", headers: { authorization: "Bearer k" } })).body;
  const token = new URL(ov.calendar_feed, "http://x").searchParams.get("token");
  const feed = await srv.handle({ method: "GET", path: "/api/calendar.ics", query: { token } });
  assert.equal(feed.status, 200);
  assert.equal(feed.ics.includes(rPendingReqCancel.reference), false);
  assert.equal(feed.ics.includes(rPendingOwnCancel.reference), false);
  assert.match(feed.ics, new RegExp(`UID:${rAcceptedCancel.reference}@overlap[\\s\\S]*?STATUS:CANCELLED`));
});
