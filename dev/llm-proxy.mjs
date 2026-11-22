// Local-only OpenAI-compatible router for development: forwards chat completions to
// Gemini's OpenAI-compatible endpoint, adding the developer's key on this machine.
// The browser sees only http://localhost:8199/v1 and a dummy key. Never deploy this.
import { createServer } from "node:http";

function key() {
  const k = process.env.LLM_API_KEY || process.env.GEMINI_API_KEY;
  if (!k) throw new Error("Set LLM_API_KEY (or GEMINI_API_KEY) in the environment.");
  return k.trim();
}
const KEY = key();
const UPSTREAM = process.env.LLM_UPSTREAM || "https://generativelanguage.googleapis.com/v1beta/openai";
const MODEL = process.env.DEV_MODEL || "gemini-4-neon";
const PORT = Number(process.env.PORT || 8199);
let n = 0;

createServer(async (req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname.endsWith("/models")) {
    res.writeHead(200, { ...cors, "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: MODEL, object: "model" }] }));
    return;
  }
  if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) { res.writeHead(404, cors); res.end(); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  body.model = MODEL;
  const id = ++n;
  const t = Date.now();
  let up;
  try {
    up = await fetch(`${UPSTREAM}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  } catch (e) {
    // An upstream timeout must not take the proxy down: answer 502 and carry on.
    console.log(`#${id} upstream error ${e?.cause?.code || e?.name || e}`);
    res.writeHead(502, { ...cors, "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "upstream error" } })); return;
  }
  res.writeHead(up.status, { ...cors, "Content-Type": up.headers.get("content-type") || "application/json" });
  let bytes = 0;
  try {
    const reader = up.body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; res.write(value); }
  } catch (e) { console.log(`#${id} stream error ${e?.name || e}`); }
  res.end();
  console.log(`#${id} ${up.status} ${MODEL} msgs=${body.messages?.length} tools=${body.tools?.length || 0} stream=${!!body.stream} ${bytes}B ${Date.now() - t}ms`);
}).listen(PORT, "127.0.0.1", () => console.log(`dev LLM proxy on http://localhost:${PORT}/v1 -> ${MODEL}`));
