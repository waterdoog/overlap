// End-to-end check in real headless Chrome, with a real model through a local router.
//
//   node tests/e2e/run.mjs [--router http://localhost:8199/v1] [--model gemini-4-neon]
//
// Starts three Overlap pages (Ana, Bo, Cy) on three origins with fresh data, signs in on
// Ana's page as its owner, adds Bo and Cy, and asks Ana's assistant to find 30 minutes.
// It approves each consent card, then asks it to send the requests, fills in each
// person's request window (a popup on that person's origin), and checks on Bo's and Cy's
// servers that: each was asked at most 6 windows, the pending requests are for a window
// all three are really free, and nothing but yes/no left their servers.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChromeLauncher } from "./chrome_launcher.mjs";
import { CdpClient } from "./cdp_client.mjs";
import { parseIcs } from "../../core/calendar.mjs";
import { isFree } from "../../core/policy.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
// --scripted: dev/script-router.mjs plays the model (no model calls, deterministic).
const SCRIPTED = process.argv.includes("--scripted");
const ROUTER = arg("--router", SCRIPTED ? "http://127.0.0.1:8198/v1" : "http://127.0.0.1:8199/v1");
const MODEL = arg("--model", SCRIPTED ? "scripted" : "gemini-4-neon");
const OUT = arg("--out", join(ROOT, "tests", "e2e", "last-run"));
const PEOPLE = [["ana", 9101], ["bo", 9102], ["cy", 9103]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const dataDir = mkdtempSync(join(tmpdir(), "overlap-e2e-"));
const START = Date.now();
// --hosted: the three people are pages on one hosted Overlap site (/u/<id>/), created from
// their iCal addresses; otherwise each is its own server on its own origin.
const HOSTED = process.argv.includes("--hosted");
// --live: the three public demo pages (resets their demo logs first). Needs the open network.
const LIVE = process.argv.includes("--live");
if (LIVE) process.env.E2E_OPEN_NETWORK = "1";
for (const port of LIVE ? [] : HOSTED ? [9200, 9299] : PEOPLE.map(([, p]) => p)) {
  const busy = await fetch(`http://localhost:${port}/`).then(() => true, () => false);
  if (busy) { console.error(`Port ${port} is already in use; stop the old server first.`); process.exit(2); }
}
const procs = LIVE ? [] : HOSTED
  ? [spawn("node", [join(ROOT, "dev", "serve-hosted.mjs"), "9200", "--allow-private-calendars"], { env: { ...process.env, DATA_DIR: dataDir }, stdio: "ignore" }),
     spawn("python3", ["-m", "http.server", "9299", "--bind", "127.0.0.1", "--directory", join(ROOT, "personas")], { stdio: "ignore" })]
  : PEOPLE.map(([p, port]) => spawn("node", [join(ROOT, "dev", "serve.mjs"), p, String(port)], { env: { ...process.env, DATA_DIR: dataDir }, stdio: "ignore" }));
const BASE = {}; const KEY = {};
if (LIVE) for (const [p] of PEOPLE) { BASE[p] = `https://overlap-${p}.vercel.app`; KEY[p] = JSON.parse(readFileSync(join(ROOT, "personas", `${p}.json`), "utf8")).dev_owner_key; }
else if (!HOSTED) for (const [p, port] of PEOPLE) { BASE[p] = `http://localhost:${port}`; KEY[p] = JSON.parse(readFileSync(join(ROOT, "personas", `${p}.json`), "utf8")).dev_owner_key; }
const keyOf = (p) => KEY[p];
async function createHostedPages() {
  await sleep(1000);
  for (const [p] of PEOPLE) {
    const prof = JSON.parse(readFileSync(join(ROOT, "personas", `${p}.json`), "utf8"));
    const h = prof.working_hours.mon;
    const r = await (await fetch("http://localhost:9200/api/pages", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: prof.name, headline: prof.headline, org: prof.org, timezone: prof.timezone, from: h[0], to: h[1], days: Object.keys(prof.working_hours), ics_url: `http://localhost:9299/${p}.ics` }) })).json();
    if (!r.ok) throw new Error(`create ${p}: ${r.reason}`);
    BASE[p] = r.page_url.replace(/\/$/, ""); KEY[p] = r.owner_key;
  }
}
const transcript = [];

async function main() {
  mkdirSync(OUT, { recursive: true });
  await sleep(800);
  if (HOSTED) await createHostedPages();
  if (LIVE) for (const [p] of PEOPLE) await fetch(`${BASE[p]}/api/owner/reset`, { method: "POST", headers: { Authorization: `Bearer ${KEY[p]}`, "Content-Type": "application/json" }, body: "{}" });
  if (await ChromeLauncher.answers(9333)) throw new Error("A browser is already on DevTools port 9333 (left by an earlier run); stop it first.");
  const chrome = new ChromeLauncher(ChromeLauncher.locate(), 9333, mkdtempSync(join(tmpdir(), "overlap-chrome-")), join(OUT, "chrome.log"));
  await chrome.start();
  activeChrome = chrome;
  const cdp = await CdpClient.connect(9333);
  const sessions = new Map(); // targetId -> sessionId
  const popups = [];
  cdp.onEvent(async (m) => {
    if (m.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo } = m.params;
      sessions.set(targetInfo.targetId, sessionId);
      if (targetInfo.type === "page" && /\/bridge\//.test(targetInfo.url || "")) popups.push({ sessionId, url: targetInfo.url });
      cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
    }
    if (m.method === "Target.targetCreated" && m.params.targetInfo.type === "page" && m.params.targetInfo.openerId) {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: m.params.targetInfo.targetId, flatten: true });
      popups.push({ sessionId, url: m.params.targetInfo.url });
    }
  });
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId: S } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, S);
  // replMode returns an un-awaited promise for an async IIFE, so await at top level.
  const ev = (expr) => cdp.evaluate(S, `await (${expr})`);
  const go = async (url) => { await cdp.send("Page.navigate", { url }, S); await sleep(1500); };

  const ANA = `${BASE.ana}/`;
  await go(ANA);
  // Model settings through the runtime's own panel (it reloads the page).
  await ev(`(async () => {
    for (let i = 0; i < 40 && !document.querySelector('#ns-router'); i++) await new Promise(r => setTimeout(r, 250));
    document.querySelector('#ns-router').value = ${JSON.stringify(ROUTER)};
    document.querySelector('#ns-model').value = ${JSON.stringify(MODEL)};
    document.querySelector('#ns-key').value = 'local-dev';
    for (const id of ['#ns-router', '#ns-model', '#ns-key']) document.querySelector(id).dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#ns-apply').click();
  })()`);
  await sleep(2500);
  // Owner sign-in and People, through the page's own methods (same as its forms).
  const setup = await ev(`(async () => {
    const { App } = await import(${JSON.stringify(`${BASE.ana}/app.js`)});
    await App.page.ready;
    const s = await App.page.signIn(${JSON.stringify(keyOf("ana"))});
    const b = await App.page.addPerson(${JSON.stringify(`${BASE.bo}/`)});
    const c = await App.page.addPerson(${JSON.stringify(`${BASE.cy}/`)});
    return { s, b: b.ok || b.reason, c: c.ok || c.reason, owner: App.page.owner, links: window.overlapEngine?.top?.network?.links };
  })()`);
  log("setup", JSON.stringify(setup));
  if (!setup.owner || setup.b !== true || setup.c !== true) throw new Error("setup failed");
  await go(ANA); // reload so the greeting and link bindings start clean
  await sleep(1500);

  await turn(ev, cdp, popups, "Find 30 minutes next week with Bo and Cy for a pricing sync.", S);
  // The demo calendars repeat weekly; the only common window is Thursday 14:30-15:00 UTC.
  const thu = new Date(); thu.setUTCDate(thu.getUTCDate() + ((4 - thu.getUTCDay() + 7) % 7 || 7));
  const day = thu.toISOString().slice(0, 10);
  await turn(ev, cdp, popups, SCRIPTED ? `Send requests for ${day} 14:30-15:00 UTC titled Pricing sync`
    : "Send both of them a request for the time that works for everyone, titled Pricing sync.", S);

  // ----- checks on the servers -----
  const results = {};
  for (const [p, port] of PEOPLE.slice(1)) {
    const r = await fetch(`${BASE[p]}/api/owner/overview`, { headers: { Authorization: `Bearer ${keyOf(p)}` } });
    results[p] = await r.json();
  }
  const events = Object.fromEntries(PEOPLE.map(([p]) => {
    const prof = JSON.parse(readFileSync(join(ROOT, "personas", `${p}.json`), "utf8"));
    return [p, { prof, ev: parseIcs(readFileSync(join(ROOT, prof.calendar.ics_file), "utf8"), prof.timezone) }];
  }));
  const allFree = (s, e) => Object.values(events).every(({ prof, ev }) => isFree(prof, ev, [], Date.parse(s), Date.parse(e)));
  const checks = [];
  for (const p of ["bo", "cy"]) {
    const ov = results[p];
    ov.receipts = ov.receipts.filter((r) => r.at >= START);
    const asked = ov.receipts.filter((r) => r.kind === "check").reduce((n, r) => n + r.asked.length, 0);
    const callers = [...new Set(ov.receipts.map((r) => r.caller))];
    const pending = ov.requests.filter((r) => r.status === "pending");
    checks.push([`${p}: asked at most 6 windows by check`, asked > 0 && asked <= 6, asked]);
    checks.push([`${p}: every receipt names Ana's page`, callers.length === 1 && callers[0] === BASE.ana, callers.join(",")]);
    checks.push([`${p}: every receipt is signed by Ana's page (verified assertion)`, ov.receipts.length > 0 && ov.receipts.every((r) => r.verified && r.page === BASE.ana), ov.receipts.map((r) => r.verified).join(",")]);
    if (pending.length) checks.push([`${p}: the request knows Ana's page`, pending[0].from_page === BASE.ana, pending[0].from_page || "none"]);
    checks.push([`${p}: one pending request`, pending.length === 1, pending.length]);
    if (pending[0]) checks.push([`${p}: request is for a window all three are free`, allFree(pending[0].start, pending[0].end), `${pending[0].start} ${pending[0].title}`]);
    if (pending[0]) checks.push([`${p}: requester details typed in the window`, pending[0].from_email === "ana@northwind.example", pending[0].from_email]);
  }
  // Bo accepts on his page; the requester's reference then yields a standard invite.
  const boPending = results.bo.requests.find((r) => r.status === "pending");
  if (boPending) {
    const auth = { Authorization: `Bearer ${keyOf("bo")}`, "Content-Type": "application/json" };
    await fetch(`${BASE.bo}/api/owner/decide`, { method: "POST", headers: auth, body: JSON.stringify({ ref: boPending.ref, decision: "accepted" }) });
    const ics = await (await fetch(`${BASE.bo}/api/invite.ics?ref=${boPending.ref}`)).text();
    checks.push(["bo: accepting yields a .ics invite for that window", ics.includes(`DTSTART:${boPending.start.replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`), ics.split("\r\n").find((l) => l.startsWith("DTSTART")) || "none"]);
  }
  const leaked = transcript.join("\n").match(/Board prep|School pickup|Incident review|Hiring panel|Teaching|Grant review|Therapy|Lab standup/g);
  checks.push(["no event titles of Bo or Cy reached Ana's chat", !leaked, leaked?.join(",") || "none"]);
  writeFileSync(join(OUT, "transcript.txt"), transcript.join("\n\n"));
  writeFileSync(join(OUT, "servers.json"), JSON.stringify(results, null, 1));
  let ok = true;
  for (const [name, pass, detail] of checks) { ok &&= pass; console.log(`${pass ? "PASS" : "FAIL"}  ${name}  (${detail})`); }
  await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  cdp.close();
  await chrome.stop();
  return ok;
}

async function turn(ev, cdp, popups, text, S) {
  log("visitor:", text);
  transcript.push(`OWNER: ${text}`);
  const before = await ev(`document.querySelectorAll('#ns-msgs .ns-msg').length`);
  await ev(`(() => { const i = document.querySelector('#ns-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('#agent-app button')].find(b => b.textContent.trim() === 'Send').click(); })()`);
  const handled = new Set();
  const deadline = Date.now() + 240000;
  await sleep(1500);
  while (Date.now() < deadline) {
    // Approve consent cards (a script click is enough) and open partner windows. A window
    // needs a real user gesture, so "Open ..." gets a real mouse click through DevTools.
    const clicked = await ev(`(() => {
      const b = [...document.querySelectorAll('#ns-msgs button')].find(b => !b.disabled && b.offsetParent && b.textContent.trim() === 'Allow');
      if (!b) return null; const t = b.closest('.ns-msg')?.innerText.slice(0, 300); b.click(); return 'Allow | ' + t; })()`);
    if (clicked) { log("clicked:", clicked.replace(/\s+/g, " ")); transcript.push(`[clicked] ${clicked}`); }
    const open = await ev(`(() => {
      const b = [...document.querySelectorAll('#ns-msgs button')].find(b => !b.disabled && b.offsetParent && /^Open /.test(b.textContent.trim()) && !b.dataset.e2e);
      if (!b) return null; b.dataset.e2e = '1'; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: b.textContent.trim() }; })()`);
    if (open) {
      for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: open.x, y: open.y, button: "left", clickCount: 1 }, S);
      log("clicked:", open.text); transcript.push(`[clicked] ${open.text}`);
      await sleep(1500);
    }
    for (const p of popups) {
      if (handled.has(p.sessionId)) continue;
      const filled = await cdp.evaluate(p.sessionId, `await (async () => {
        for (let i = 0; i < 40 && !document.querySelector('#rw-from_name'); i++) await new Promise(r => setTimeout(r, 250));
        const f = document.querySelector('form'); if (!f) return null;
        const summary = document.querySelector('.summary')?.innerText;
        f.from_name.value = 'Ana Lindqvist'; f.from_email.value = 'ana@northwind.example'; f.note.value = 'Agenda: Q1 pricing';
        // Submit after returning: the window closes once the request is sent.
        setTimeout(() => f.requestSubmit(), 50);
        return location.host + ' | ' + summary;
      })()`).catch((e) => `error ${e.message}`);
      if (filled) { handled.add(p.sessionId); log("window:", filled.replace(/\s+/g, " ")); transcript.push(`[window] ${filled}`); }
    }
    const state = await ev(`({ busy: !!document.querySelector('#ns-msgs .ns-turn-status'), n: document.querySelectorAll('#ns-msgs .ns-msg').length })`);
    if (!state.busy && state.n > before + 1) break;
    await sleep(1200);
  }
  const reply = await ev(`[...document.querySelectorAll('#ns-msgs .ns-msg.bot')].filter(m => !m.classList.contains('ns-consent')).pop()?.innerText || ''`);
  log("assistant:", reply.slice(0, 1500));
  transcript.push(`ASSISTANT: ${reply}`);
  return reply;
}

let code = 1;
let activeChrome = null;
try { code = (await main()) ? 0 : 1; }
catch (e) { console.error(e); }
finally { for (const p of procs) p.kill(); await activeChrome?.stop().catch(() => {}); }
process.exit(code);
