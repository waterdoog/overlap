// Renders the page from App.page: profile, rules, the manual check form and the owner's
// panels. Works without the assistant.
import { App } from "./app.js";
import { Api } from "./js/api.js";
import { label } from "./js/time.js";

const page = App.page;
const $ = (s) => document.querySelector(s);
const el = (tag, text = "", cls = "") => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
const myTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

function renderProfile() {
  const p = page.profile;
  document.title = `${p.name} · Overlap`;
  document.documentElement.style.setProperty("--person", p.color);
  $("#p-avatar").textContent = p.initials;
  $("#p-name").textContent = p.name;
  $("#p-headline").textContent = [p.headline, p.org].filter(Boolean).join(" · ");
  $("#p-about").textContent = p.about;
  $("#p-topics").replaceChildren(...p.topics.map((t) => el("li", t)));
  $("#p-tz").textContent = p.timezone;
  $("#p-hours").textContent = p.public_hours || "Not published";
  const tick = () => { $("#p-now").textContent = label(Date.now(), p.timezone); };
  tick(); setInterval(tick, 30000);
  for (const n of document.querySelectorAll(".who-first")) n.textContent = p.name.split(" ")[0];
  $("#r-mode").textContent = p.answer_mode === "helpful"
    ? "Helpful mode: when no asked time is free, it may offer up to two nearby free times."
    : "Strict mode: no suggestions, only the answer to the question asked.";
  $("#r-budget").textContent = `At most ${p.rules.max_windows_per_question} times per question. A page that proves who it is (a signed assertion from its owner) gets ${p.rules.per_page_per_day} a day; everyone else shares ${p.rules.unverified_total_per_day} a day. However many askers, at most ${p.rules.per_week_total} answers about any one week.`;
  $("#your-tz").textContent = myTz;
}

function manualForm() {
  const form = $("#manual-form");
  const out = $("#manual-result");
  const d = new Date(Date.now() + 86400000);
  form.date.value = d.toISOString().slice(0, 10);
  form.time.value = "15:00";
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const [y, m, day] = form.date.value.split("-").map(Number);
    const [hh, mm] = form.time.value.split(":").map(Number);
    const start = new Date(y, m - 1, day, hh, mm);
    const end = new Date(start.getTime() + Number(form.minutes.value) * 60000);
    out.textContent = "Asking…";
    const r = await page.checkWindows({ windows: [{ start: start.toISOString(), end: end.toISOString() }], purpose: "manual check" });
    if (!r.ok) { out.textContent = r.reason; out.className = "no-text"; return; }
    const a = r.answers[0];
    out.className = a.available ? "yes-text" : "no-text";
    out.textContent = `${a.available ? "Free" : "Not free"}: ${label(Date.parse(a.start), myTz)} your time (${a.local} ${r.owner_timezone}).`
      + (r.suggestions.length ? ` Also free: ${r.suggestions.map((s) => label(Date.parse(s.start), myTz)).join(", ")}.` : "")
      + ` ${r.budget_left} questions left today from this site.`;
    if (page.owner) page.refreshOwner();
  });
}

function renderOwner() {
  const box = $("#owner");
  box.hidden = !page.owner;
  $("#owner-toggle").textContent = page.owner ? `Owner ✓` : "Owner";
  if (!page.owner) return;
  // People
  $("#people-list").replaceChildren(...page.people.map((x) => {
    const li = el("li", "", "person");
    const av = el("span", x.initials, "avatar small"); av.style.background = x.color;
    const txt = el("div");
    txt.append(el("strong", x.name), el("span", ` ${x.org || ""}`, "muted"), el("div", `${x.timezone} · ${x.slot} · ${new URL(x.origin).host}`, "muted small mono"));
    const rm = el("button", "Remove", "secondary small-btn"); rm.type = "button";
    rm.addEventListener("click", () => page.removePerson(x.slot));
    li.append(av, txt, rm);
    return li;
  }));
  if (!page.people.length) $("#people-list").append(el("li", "Nobody yet.", "muted"));
  const ov = page.overview;
  if (!ov) return;
  // Requests
  const reqs = ov.requests.filter((r) => r.status === "pending").concat(ov.requests.filter((r) => r.status !== "pending")).slice(0, 12);
  $("#request-list").replaceChildren(...(reqs.length ? reqs.map((r) => {
    const li = el("li", "", `request ${r.status}`);
    const t = el("div");
    t.append(el("strong", r.title), el("div", `${label(Date.parse(r.start), page.profile.timezone)}–${label(Date.parse(r.end), page.profile.timezone, false)} · from ${r.from_name}${r.from_email ? ` <${r.from_email}>` : ""} via ${r.from_page ? `their Overlap page ${hostOf(r.from_page)}` : hostOf(r.caller)}`, "muted small"));
    if (r.note) t.append(el("div", `“${r.note}”`, "small"));
    li.append(t);
    if (r.status === "pending") {
      const acts = el("div", "", "actions");
      for (const [d, txt] of [["accepted", "Accept"], ["declined", "Decline"]]) {
        const b = el("button", txt, d === "declined" ? "secondary" : ""); b.type = "button";
        b.addEventListener("click", async () => { await Api.decide(r.ref, d); page.refreshOwner(); });
        acts.append(b);
      }
      li.append(acts);
    } else {
      li.append(el("span", `${r.status} · ${r.ref}`, `pill ${r.status}`));
      if (r.status === "accepted") { const a = el("a", "Invite (.ics)", "small"); a.href = Api.url(`/api/invite.ics?ref=${r.ref}`); li.append(a); }
    }
    return li;
  }) : [el("li", "No requests yet.", "muted")]));
  $("#feed-link").href = new URL(ov.calendar_feed, location.href).href;
  // Budget
  const b = ov.budget;
  const meter = $("#budget-meter");
  meter.replaceChildren(el("span", `${b.pages_used_today} / ${b.pages_total_per_day} to signed pages · ${b.unverified_used_today} / ${b.unverified_total_per_day} unverified`, "small"));
  const bar = el("div", "", "bar"); const fill = el("span"); fill.style.width = `${Math.min(100, (100 * b.used_today) / b.total_per_day)}%`; bar.append(fill); meter.append(bar);
  // Grants: pages that proved who they are, and what each may ask
  const grants = ov.grants || {};
  const pages = [...new Set([...ov.pages, ...Object.keys(grants)])];
  $("#grant-list").replaceChildren(...(pages.length ? pages.map((pg) => {
    const li = el("li", "", "grant");
    li.append(el("span", hostOf(pg) + new URL(pg).pathname.replace(/^\/$/, ""), "mono small"));
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", `Access for ${pg}`);
    for (const [v, t] of [["default", `Default (${ov.budget.per_page_per_day}/day)`], ["trusted", "Trusted (36/day, no weekly cap)"], ["blocked", "Blocked"]]) sel.append(Object.assign(document.createElement("option"), { value: v, textContent: t }));
    const g = grants[pg];
    sel.value = g?.blocked ? "blocked" : g?.per_day === 36 ? "trusted" : "default";
    sel.addEventListener("change", async () => {
      await Api.grant(sel.value === "default" ? { page: pg, reset: true } : sel.value === "blocked" ? { page: pg, blocked: true } : { page: pg, per_day: 36, trusted: true });
      page.refreshOwner();
    });
    li.append(sel);
    return li;
  }) : [el("li", "No page has asked with a signed assertion yet.", "muted small")]));
  // Mode
  for (const btn of document.querySelectorAll(".seg button")) btn.setAttribute("aria-checked", String(btn.dataset.mode === ov.profile.answer_mode));
  // Receipts
  $("#receipt-rows").replaceChildren(...(ov.receipts.length ? ov.receipts.slice(0, 30).map((r) => {
    const tr = el("tr");
    const asked = r.asked.map((w) => label(Date.parse(w.start), page.profile.timezone)).join("\n");
    let answered;
    if (r.refused) answered = "refused: over budget";
    else {
      answered = r.answers.map((a) => (a ? "yes" : "no")).join("\n");
      if (r.suggestions?.length) answered += `\n+ offered ${r.suggestions.map((s) => label(Date.parse(s.start), page.profile.timezone, false)).join(", ")}`;
    }
    const kind = r.kind === "request" ? "request: " : "";
    const who = el("td", "", "mono small");
    who.append(el("span", hostOf(r.caller)), el("span", r.verified ? " ✓ signed" : " unverified", r.verified ? "signed" : "muted"));
    tr.append(el("td", label(r.at, page.profile.timezone), "mono small"), who, el("td", `${kind}${asked}`, "pre small"), el("td", answered, "pre small"));
    return tr;
  }) : [Object.assign(el("tr"), { innerHTML: '<td colspan="4" class="muted">No one has asked yet.</td>' })]));
}

function hostOf(o) { try { return new URL(o).host; } catch { return o; } }

function ownerControls() {
  const dialog = $("#owner-dialog");
  $("#owner-toggle").addEventListener("click", () => {
    if (page.owner) { $("#owner").scrollIntoView({ behavior: "smooth" }); return; }
    $("#owner-msg").hidden = true; dialog.showModal();
  });
  $("#owner-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value === "cancel") return;
    e.preventDefault();
    const r = await page.signIn($("#owner-form").key.value);
    if (!r.ok) { $("#owner-msg").textContent = r.reason; $("#owner-msg").hidden = false; return; }
    dialog.close(); $("#owner-form").reset();
  });
  $("#sign-out").addEventListener("click", () => page.signOut());
  // Hosted pages (under /u/<id>/) can be deleted by their owner, with everything stored.
  if (/\/u\/[^/]+\/$/.test(location.pathname)) {
    $("#delete-page").hidden = false;
    $("#delete-page").addEventListener("click", async () => {
      if (!confirm("Delete this page, its receipts and requests, and the calendar address stored with it? This cannot be undone.")) return;
      const r = await Api.call("POST", "/api/owner/delete", {}, { owner: true });
      if (r.ok) { page.signOut(); location.href = "../../"; }
    });
  }
  $("#refresh-owner").addEventListener("click", () => page.refreshOwner());
  $("#reset-owner").addEventListener("click", async () => { await Api.reset(); page.refreshOwner(); });
  for (const btn of document.querySelectorAll(".seg button")) {
    btn.addEventListener("click", async () => { await Api.settings({ answer_mode: btn.dataset.mode }); page.profile = await Api.profile(); renderProfile(); page.refreshOwner(); });
  }
  $("#people-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#people-msg");
    const r = await page.addPerson(e.target.url.value);
    msg.hidden = r.ok; msg.textContent = r.ok ? "" : r.reason;
    if (r.ok) e.target.reset();
  });
  // Keep the receipts current while the owner watches.
  setInterval(() => { if (page.owner && document.visibilityState === "visible") page.refreshOwner(); }, 5000);
}

function demoBar() {
  const d = page.profile.demo;
  if (!d) return;
  $("#demo-bar").hidden = false;
  $("#demo-owner").addEventListener("click", async () => {
    await page.signIn(d.owner_key);
    if (!page.people.length) for (const u of d.people) await page.addPerson(u);
    $("#owner").scrollIntoView({ behavior: "smooth" });
  });
  Promise.all(d.people.map((u) => fetch(new URL("api/profile", u)).then((r) => r.json()).catch(() => null))).then((ps) => {
    $("#demo-links").replaceChildren(...ps.map((p, i) => { if (!p) return el("span"); const a = el("a", `${p.name.split(" ")[0]}'s page`, "small"); a.href = d.people[i]; return a; }));
  });
  $("#demo-reset").addEventListener("click", async () => {
    await fetch(Api.url("/api/demo-reset"), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    page.refreshOwner();
  });
}

await page.ready;
renderProfile();
demoBar();
manualForm();
ownerControls();
page.onChange(renderOwner);
renderOwner();
