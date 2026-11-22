// The one write this page shares with other agent sites: a meeting request.
// It runs in a window on THIS origin. The visitor types their own name and email here,
// never in the other site's chat, and the request stays pending until the owner accepts.
import { Api } from "../js/api.js";
import { assertionFrom, helloTo } from "../js/grant.js";

if (typeof window !== "undefined" && window.opener) helloTo(window.opener);

export class RequestWindow {
  static CALLERS = ["*"];

  static FIELDS = [
    { name: "from_name", label: "Your name", type: "text", autocomplete: "name", maxLength: 80 },
    { name: "from_email", label: "Your email", type: "email", autocomplete: "email", maxLength: 120, optionalWithPage: true },
    { name: "note", label: "Note (optional)", type: "text", autocomplete: "off", maxLength: 300, optional: true },
  ];

  static definition() {
    return {
      name: "request_meeting",
      description: "Send this person a meeting request for one exact window that check_windows said is free. A window opens on this person's page, where the visitor checks it and types their own name and email, so never ask for them. The request stays pending until the person accepts. Returns the reference, or ok false with the reason, such as the visitor cancelling or the time no longer being free.",
      effect: "irreversible",
      availability: "bridge",
      callerOrigins: RequestWindow.CALLERS,
      confirmsInWindow: true,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "title"],
        properties: {
          start: { type: "string", description: "Start, ISO 8601 UTC on a quarter hour." },
          end: { type: "string", description: "End, ISO 8601 UTC." },
          title: { type: "string", minLength: 1, maxLength: 100, description: "Short meeting title, such as Q1 pricing sync. No names or emails." },
        },
      },
      execute: RequestWindow.start,
    };
  }

  static async start(args, context) {
    const profile = await Api.profile();
    // The browser vouches for the asking page's origin. If it is an Overlap page, show whose
    // page it is and fill in the name, so the visitor only checks and sends.
    let from = null;
    try {
      // The asking page: from its signed assertion (verified again by this page's server),
      // or, across origins, from the origin the browser reports.
      const token = await assertionFrom(context?.callerOrigin, 800);
      let pageUrl = "";
      if (token) pageUrl = JSON.parse(atob(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"))).iss || "";
      else if (context?.callerOrigin && new URL(context.callerOrigin).origin !== location.origin) pageUrl = new URL(context.callerOrigin).origin;
      if (pageUrl) {
        const p = await (await fetch(`${pageUrl}/api/profile`, { cache: "no-store" })).json();
        if (p?.ok && p.name) from = { origin: new URL(pageUrl).origin, page: pageUrl, name: p.name, org: p.org, signed: !!token };
      }
    } catch {}
    const state = { args, profile, from, caller: RequestWindow.hostOf(context?.callerOrigin), callerOrigin: context?.callerOrigin, done: false };
    return new Promise((resolve) => RequestWindow.show(state, resolve));
  }

  static when(args, timeZone) {
    const opts = { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
    const fmt = (tz) => new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: tz }).format(new Date(args.start))
      + "–" + new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz }).format(new Date(args.end));
    const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return { theirs: `${fmt(timeZone)} (${timeZone})`, yours: `${fmt(mine)} (${mine})` };
  }

  static show(state, resolve) {
    state.resolve = resolve;
    const p = state.profile;
    if (!state.container) {
      document.title = `Request a meeting with ${p.name}`;
      const sheet = document.createElement("link");
      sheet.rel = "stylesheet";
      sheet.href = new URL("../styles.css", import.meta.url).href;
      document.head.append(sheet);
      document.body.classList.add("window-page");
    }
    const when = RequestWindow.when(state.args, p.timezone);
    const main = el("main", "", "window");
    const head = el("header", "", "window-head");
    const badge = el("span", p.initials, "avatar small");
    badge.style.background = p.color;
    head.append(badge, el("span", `${p.name}'s page`, "brand"));
    const intro = el("section", "", "panel");
    intro.append(
      el("h1", `Request a meeting with ${p.name}`),
      el("p", state.container
        ? `The assistant asked to send this. Type your details here, not in the chat. ${p.name} sees the request and decides; the chat gets only a reference.`
        : `The assistant on ${state.caller} asked to send this. Type your details here, not in the chat. ${p.name} sees the request and decides; the chat gets only a reference.`),
    );
    const summary = el("section", "", "panel summary");
    if (state.from) summary.append(kv("From", `${state.from.name}${state.from.org ? `, ${state.from.org}` : ""} (${state.from.signed ? "signed by" : "from"} their Overlap page, ${state.from.page.replace(/^https?:\/\//, "")})`));
    summary.append(
      kv("What", state.args.title),
      kv(`${p.name.split(" ")[0]}'s time`, when.theirs),
      kv("Your time", when.yours),
    );
    const form = el("form", "", "panel");
    form.noValidate = true;
    const error = el("p", "", "field-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const fs = document.createElement("fieldset");
    fs.append(el("legend", "Your details"));
    for (const f of RequestWindow.FIELDS) {
      const wrap = el("div", "", "field");
      const label = el("label", f.label);
      label.htmlFor = `rw-${f.name}`;
      const input = document.createElement("input");
      const optional = f.optional || (f.optionalWithPage && state.from);
      if (optional && !f.optional) label.textContent = `${f.label} (optional: ${state.from.name.split(" ")[0]}'s page gets the answer)`;
      Object.assign(input, { id: `rw-${f.name}`, name: f.name, type: f.type, autocomplete: f.autocomplete, maxLength: f.maxLength, required: !optional });
      if (f.name === "from_name" && state.from) input.value = state.from.name;
      wrap.append(label, input);
      fs.append(wrap);
    }
    const send = el("button", "Send request");
    send.type = "submit";
    const cancel = el("button", "Don't send", "secondary");
    cancel.type = "button";
    const actions = el("div", "", "actions");
    actions.append(send, cancel);
    form.append(error, fs, actions);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (state.done) return;
      const details = Object.fromEntries(RequestWindow.FIELDS.map((f) => [f.name, form.elements[f.name].value.trim()]));
      const emailOk = details.from_email ? /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(details.from_email) : !!state.from;
      if (!details.from_name || !emailOk) {
        error.textContent = state.from ? "Enter your name, and a valid email if you give one." : "Enter your name and a valid email.";
        error.hidden = false;
        return;
      }
      send.disabled = true;
      let done;
      const assertion = state.container ? "" : await assertionFrom(state.callerOrigin, 800);
      try { done = await Api.request(state.args, details, state.callerOrigin, assertion); }
      catch (e) { send.disabled = false; error.textContent = "The page's server could not be reached. Try again."; error.hidden = false; return; }
      if (!done.ok) { send.disabled = false; error.textContent = done.reason; error.hidden = false; return; }
      state.done = true;
      const box = el("section", "", "panel confirmation");
      box.append(el("h2", "Request sent"), el("p", `Reference ${done.reference}. ${done.message}`), el("p", state.container ? "The chat shows the reference too." : `This window closes now. The chat on ${state.caller} shows the reference too.`));
      main.replaceChildren(head, box);
      resolve({ ok: true, reference: done.reference, status: "pending", start: done.start, end: done.end, summary: `Request ${done.reference} sent to ${p.name} for ${when.theirs}. Pending until ${p.name} accepts.`, note: "The visitor typed their details in this person's window, which has now closed." });
    });
    cancel.addEventListener("click", () => {
      if (state.done) return;
      state.done = true;
      const box = el("section", "", "panel");
      box.append(el("h2", "Not sent"), el("p", state.container ? "Nothing was sent." : `Nothing was sent. This window closes now, and the chat on ${state.caller} carries on.`));
      main.replaceChildren(head, box);
      resolve({ ok: false, reason: "The visitor chose not to send the request. Nothing was sent." });
    });
    main.append(head, intro, summary, form);
    (state.container || document.body).append(main);
    (state.from ? send : form.elements.from_name).focus();
  }

  static hostOf(origin) {
    try { return new URL(origin).host; } catch { return "another site"; }
  }
}

function el(tag, text, className = "") {
  const e = document.createElement(tag);
  e.textContent = text;
  if (className) e.className = className;
  return e;
}

function kv(k, v) {
  const row = el("div", "", "kv");
  row.append(el("span", k, "k"), el("span", v, "v"));
  return row;
}
