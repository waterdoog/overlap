// A scripted, OpenAI-compatible "model" for testing Overlap without any model calls.
// It plays both sides by fixed rules, so a browser test exercises the real runtime, bridges,
// consent cards, signed assertions and servers deterministically and for free.
//
//   node dev/script-router.mjs [port]      (default 8198; models: "scripted")
//
// Ana's assistant (it is offered website_candidate_windows):
//   "Find ..."  -> get_profile, candidate_windows, then each person_N with those windows, then a summary.
//   "Send ... for YYYY-MM-DD HH:MM-HH:MM UTC titled T" -> each person_N with that request, then a summary.
// A person's page (offered website_check_windows but not candidate_windows):
//   a request with windows -> check_windows; "Send a meeting request ..." -> request_meeting.
import { createServer } from "node:http";

const PORT = Number(process.argv[2] || 8198);
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

function decide(body) {
  const tools = (body.tools || []).map((t) => t.function?.name);
  const has = (t) => tools.includes(t);
  const msgs = body.messages || [];
  const done = toolResults(msgs);
  const ask = lastUser(msgs);
  const people = tools.filter((t) => /^person_\d$/.test(t));
  if (has("website_candidate_windows")) {
    // Only calls made after the latest user message count for this turn.
    const turnStart = msgs.map((m) => m.role).lastIndexOf("user");
    const turnDone = toolResults(msgs.slice(turnStart));
    if (/^\s*send/i.test(ask)) {
      // Ask only the people the last search asked (named in the previous summary).
      const prev = [...msgs].reverse().find((m) => m.role === "assistant" && String(m.content || "").startsWith("CALLER_FINAL"));
      const asked = prev ? [...String(prev.content).matchAll(/(person_\d):/g)].map((m) => m[1]) : people;
      people.splice(0, people.length, ...people.filter((p) => asked.includes(p)));
      const [w] = windowsIn(ask);
      const title = (/titled (.+?)\.?$/.exec(ask) || [])[1] || "Meeting";
      const next = people.find((p) => !turnDone[p]);
      if (next && w) return { tool: next, args: { request: `Send a meeting request for ${w.start.slice(0, 10)} ${w.start.slice(11, 16)}-${w.end.slice(11, 16)} UTC titled ${title}` } };
      return { text: `CALLER_FINAL: ${people.map((p) => `${p}: ${(turnDone[p] || [""]).at(-1)}`).join(" | ")}` };
    }
    if (!turnDone.website_get_profile) return { tool: "website_get_profile", args: {} };
    if (!turnDone.website_candidate_windows) return { tool: "website_candidate_windows", args: { minutes: 30 } };
    const cand = turnDone.website_candidate_windows.at(-1);
    const ws = [...cand.matchAll(/"start":"([^"]+)","end":"([^"]+)"/g)].map(([, s, e]) => `${s.slice(0, 10)} ${s.slice(11, 16)}-${e.slice(11, 16)} UTC`);
    const used = people.filter((p) => JSON.parse(cand.match(/"people":(\[[^\]]*\])/)?.[1] || "[]").some((x) => x.tool === p));
    const next = used.find((p) => !turnDone[p]);
    if (next) return { tool: next, args: { request: `Free for 30 min at any of: ${ws.join(", ")}? Topic: pricing sync` } };
    return { text: `CALLER_FINAL: ${used.map((p) => `${p}: ${(turnDone[p] || [""]).at(-1)}`).join(" | ")}` };
  }
  if (has("website_check_windows")) {
    const send = /Send a meeting request for (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})-(\d{2}:\d{2}) UTC titled (.+)$/i.exec(ask);
    if (send && !done.website_request_meeting) {
      const [, d, s, e, title] = send;
      return { tool: "website_request_meeting", args: { start: `${d}T${s}:00Z`, end: `${d}T${e}:00Z`, title: title.trim() } };
    }
    const ws = windowsIn(ask);
    if (!send && ws.length && !done.website_check_windows) return { tool: "website_check_windows", args: { windows: ws.slice(0, 6), purpose: "pricing sync" } };
    const res = (done.website_request_meeting || done.website_check_windows || ["(no tool)"]).at(-1);
    return { text: `PASS_ANSWER: ${res}` };
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

createServer(async (req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
  if (req.method === "GET" && req.url.endsWith("/models")) { res.writeHead(200, { ...cors, "Content-Type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "scripted", object: "model" }] })); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  const reply = decide(body);
  console.log(reply.tool ? `-> ${reply.tool} ${JSON.stringify(reply.args).slice(0, 160)}` : `-> text ${reply.text.slice(0, 160)}`);
  if (body.stream) { res.writeHead(200, { ...cors, "Content-Type": "text/event-stream" }); res.end(sse(body.model, reply)); return; }
  const message = reply.tool
    ? { role: "assistant", content: null, tool_calls: [{ id: `call_s${++n}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }
    : { role: "assistant", content: reply.text };
  res.writeHead(200, { ...cors, "Content-Type": "application/json" });
  res.end(JSON.stringify({ id: "chatcmpl-s", object: "chat.completion", choices: [{ index: 0, message, finish_reason: reply.tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
}).listen(PORT, "127.0.0.1", () => console.log(`scripted router on http://localhost:${PORT}/v1`));
