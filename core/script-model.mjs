// A scripted, OpenAI-compatible "model" for Overlap: plays both sides by fixed rules, so the
// real runtime, bridges, consent cards, signed assertions and servers can run with no model,
// no key and no cost. Used by tests, and by the public "scripted demo" router so anyone can
// watch the whole flow without an AI key. It is not AI: it only follows the script below.
//
// Ana's assistant (it is offered website_candidate_windows):
//   "Find ..."  -> get_profile, candidate_windows, then each person_N with those windows, then a summary.
//   "Send ... for YYYY-MM-DD HH:MM-HH:MM UTC titled T" -> each person_N with that request, then a summary.
// A person's page (offered website_check_windows but not candidate_windows):
//   a request with windows -> check_windows; "Send a meeting request ..." -> request_meeting.
const WIN = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})-(\d{2}:\d{2}) UTC/g;
let n = 0;

function toolResults(messages) {
  const names = {};
  for (const m of messages) for (const c of m.tool_calls || []) names[c.id] = c.function.name;
  const out = {};
  for (const m of messages) if (m.role === "tool") (out[names[m.tool_call_id]] ||= []).push(String(m.content || ""));
  return out;
}

function lastUser(messages) {
  const u = [...messages].reverse().find((m) => m.role === "user");
  return typeof u?.content === "string" ? u.content : (u?.content || []).map((p) => p.text || "").join(" ");
}

function windowsIn(text) {
  return [...text.matchAll(WIN)].map(([, d, s, e]) => ({ start: `${d}T${s}:00Z`, end: `${d}T${e}:00Z` }));
}

const fmt = (iso, tz) => new Intl.DateTimeFormat("en-GB", { timeZone: tz || "UTC", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
const utc = (w) => `${w.start.slice(0, 10)} ${w.start.slice(11, 16)}-${w.end.slice(11, 16)} UTC`;
const json = (t) => { try { return JSON.parse(t); } catch { return null; } };
// A website_* tool result is a receipt {status, result}; a person_N result is {cruse, text}
// whose text the person's page wrote, ending in "DATA: <json>".
const receipt = (t) => json(t)?.result ?? null;
const partnerData = (t) => { const x = json(t); const text = x?.text ?? String(t || ""); const i = text.lastIndexOf("DATA: "); return i >= 0 ? json(text.slice(i + 6)) : null; };
const NOTE = "(Scripted demo model: no AI, a fixed script so you can see the protocol. Connect a real model in AI model settings for the real assistant.)";

export function decide(body) {
  const tools = (body.tools || []).map((t) => t.function?.name);
  const has = (t) => tools.includes(t);
  const msgs = body.messages || [];
  const ask = lastUser(msgs);
  // Only calls made after the latest user message count for this turn.
  const turnStart = msgs.map((m) => m.role).lastIndexOf("user");
  const done = toolResults(msgs.slice(turnStart));
  if (has("website_candidate_windows")) {
    if (!done.website_get_profile) return { tool: "website_get_profile", args: {} };
    const prof = receipt(done.website_get_profile.at(-1)) || {};
    const tz = prof.page_owner?.timezone;
    const owner = prof.page_owner?.name || "this person";
    if (!prof.visitor_is_owner) {
      const ws = windowsIn(ask);
      if (!ws.length) return { text: `I can tell you whether ${owner} is free at exact times. Try: "Is ${owner.split(" ")[0]} free ${utc({ start: new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10) + "T14:30:00Z", end: new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10) + "T15:00:00Z" })}?"\n\n${NOTE}` };
      if (!done.website_check_windows) return { tool: "website_check_windows", args: { windows: ws.slice(0, 6), purpose: "meeting" } };
      const r = receipt(done.website_check_windows.at(-1)) || {};
      if (!r.ok) return { text: `${r.reason || "The page could not answer."}\n\n${NOTE}` };
      return { text: `${r.answers.map((a) => `- ${fmt(a.start, tz)} (${owner.split(" ")[0]}'s time): **${a.available ? "free" : "not free"}**`).join("\n")}\n\n${NOTE}` };
    }
    const people = (prof.people || []).map((x) => x.tool).filter((t) => tools.includes(t));
    const nameOf = Object.fromEntries((prof.people || []).map((x) => [x.tool, x.name]));
    if (!people.length) return { text: `Add people's Overlap pages under People first (the demo bar's "Sign in" adds two).\n\n${NOTE}` };
    if (/^\s*(yes|send|book|request)/i.test(ask)) {
      let [w] = windowsIn(ask);
      if (!w) {
        const prev = [...msgs].reverse().find((m) => m.role === "assistant" && /UTC window: /.test(String(m.content || "")));
        [w] = prev ? windowsIn(String(prev.content).slice(String(prev.content).indexOf("UTC window: "))) : [];
      }
      if (!w) return { text: `Which time? Ask me to find one first.\n\n${NOTE}` };
      const title = (/titled (.+?)\.?$/i.exec(ask) || [])[1] || "Meeting";
      const next = people.find((p) => !done[p]);
      if (next) return { tool: next, args: { request: `Send a meeting request for ${utc(w)} titled ${title}` } };
      const lines = people.map((p) => { const d = partnerData(done[p].at(-1)); return d?.reference ? `- ${nameOf[p]}: request **${d.reference}** sent, pending until they accept.` : `- ${nameOf[p]}: not sent (${d?.reason || "no answer"}).`; });
      return { text: `${lines.join("\n")}\n\nEach request was made on that person's own page; once they accept, their page offers a calendar invite (.ics).\n\n${NOTE}` };
    }
    if (!done.website_candidate_windows) return { tool: "website_candidate_windows", args: { minutes: 30 } };
    const cand = receipt(done.website_candidate_windows.at(-1)) || {};
    if (!cand.ok || !cand.windows?.length) return { text: `${cand.reason || cand.note || "No candidate windows."}\n\n${NOTE}` };
    const asked = people.filter((p) => (cand.people || []).some((x) => x.tool === p));
    const next = asked.find((p) => !done[p]);
    if (next) return { tool: next, args: { request: `Free for 30 min at any of: ${cand.windows.map(utc).join(", ")}? Topic: pricing sync` } };
    const answers = Object.fromEntries(asked.map((p) => [p, partnerData(done[p].at(-1))]));
    const rows = cand.windows.map((w) => {
      const cells = asked.map((p) => { const a = answers[p]?.answers?.find((x) => Date.parse(x.start) === Date.parse(w.start)); return a ? (a.available ? "free" : "not free") : "no answer"; });
      return { w, cells, all: cells.every((c) => c === "free") };
    });
    const table = [`| Your time (${tz}) | ${asked.map((p) => nameOf[p]).join(" | ")} |`, `|---|${asked.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${fmt(r.w.start, tz)} | ${r.cells.join(" | ")} |`)].join("\n");
    const win = rows.find((r) => r.all);
    const tail = win ? `**Works for everyone: ${fmt(win.w.start, tz)}** (UTC window: ${utc(win.w)}). Say "send the requests" to ask each person's page.` : `No window works for everyone. Ask me to try other times.`;
    return { text: `I asked each person's page about ${cand.windows.length} times; each page answered only yes or no.\n\n${table}\n\n${tail}\n\n${NOTE}` };
  }
  if (has("website_check_windows")) {
    const send = /Send a meeting request for (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})-(\d{2}:\d{2}) UTC titled (.+)$/i.exec(ask);
    if (send && !done.website_request_meeting) {
      const [, d, s, e, title] = send;
      return { tool: "website_request_meeting", args: { start: `${d}T${s}:00Z`, end: `${d}T${e}:00Z`, title: title.trim() } };
    }
    const ws = windowsIn(ask);
    if (!send && ws.length && !done.website_check_windows) return { tool: "website_check_windows", args: { windows: ws.slice(0, 6), purpose: "pricing sync" } };
    const r = receipt((done.website_request_meeting || done.website_check_windows || ["null"]).at(-1)) || { ok: false, reason: "no tool result" };
    const human = r.answers ? r.answers.map((a) => `${a.local}: ${a.available ? "free" : "not free"}`).join("; ") : r.reference ? `Request ${r.reference} sent, pending.` : r.reason || "";
    return { text: `${human}\n\nDATA: ${JSON.stringify(r)}` };
  }
  return { text: "SCRIPT: nothing to do" };
}

function sse(model, reply) {
  n += 1;
  const delta = reply.tool
    ? { role: "assistant", tool_calls: [{ index: 0, id: `call_s${n}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }
    : { role: "assistant", content: reply.text };
  const chunk = { id: "chatcmpl-s", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: reply.tool ? "tool_calls" : "stop" }] };
  const usage = { id: "chatcmpl-s", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
  return `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(usage)}\n\ndata: [DONE]\n\n`;
}


export function respond(body) {
  const reply = decide(body);
  if (body.stream) return { reply, stream: sse(body.model, reply) };
  const message = reply.tool
    ? { role: "assistant", content: null, tool_calls: [{ id: `call_s${++n}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }
    : { role: "assistant", content: reply.text };
  return { reply, json: { id: "chatcmpl-s", object: "chat.completion", choices: [{ index: 0, message, finish_reason: reply.tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } };
}

export const MODELS = { data: [{ id: "scripted", object: "model" }] };
