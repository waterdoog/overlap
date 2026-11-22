// The demo pages' free model: an OpenAI-compatible router that forwards to Gemini with the
// project's own key (DEMO_LLM_KEY, a Vercel environment variable; never sent to browsers).
// Limited per network address and per day, so it can be offered to anyone without a key.
// vercel.json rewrites /llm/v1/* here.
import { createHash } from "node:crypto";
import { storeFromEnv } from "../core/store.mjs";

const UPSTREAM = process.env.DEMO_LLM_UPSTREAM || "https://generativelanguage.googleapis.com/v1beta/openai";
const MODEL = process.env.DEMO_LLM_MODEL || "gemini-4-neon";
const PER_ADDRESS = Number(process.env.DEMO_LLM_PER_ADDRESS || 120);
const PER_DAY = Number(process.env.DEMO_LLM_PER_DAY || 3000);
const usage = storeFromEnv("llm-usage");

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  const key = process.env.DEMO_LLM_KEY;
  const url = new URL(req.url, "http://x");
  const path = url.searchParams.get("p") || url.pathname;
  if (req.method === "GET" && path.endsWith("/models")) { res.status(200).json({ data: key ? [{ id: MODEL, object: "model" }] : [] }); return; }
  if (!key) { res.status(503).json({ error: { message: "The free demo model is not available right now. Connect your own model, or use the scripted demo." } }); return; }
  if (req.method !== "POST" || !path.endsWith("/chat/completions")) { res.status(404).json({ error: { message: "not found" } }); return; }
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const who = createHash("sha256").update(`llm:${ip}`).digest("hex").slice(0, 12);
  const day = new Date().toISOString().slice(0, 10);
  const allowed = await usage.update((s) => {
    if (s.day !== day) { s.day = day; s.total = 0; s.by = {}; }
    s.by = s.by || {};
    if ((s.total || 0) >= PER_DAY || (s.by[who] || 0) >= PER_ADDRESS) return false;
    s.total = (s.total || 0) + 1; s.by[who] = (s.by[who] || 0) + 1;
    return true;
  }).catch(() => true);
  if (!allowed) { res.status(429).json({ error: { message: "The free demo model has reached today's limit. Connect your own model in AI model settings, or use the scripted demo." } }); return; }
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = { ...(body || {}), model: MODEL };
  let up;
  try {
    up = await fetch(`${UPSTREAM}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  } catch {
    res.status(502).json({ error: { message: "The free demo model did not answer. Try again, or connect your own model." } }); return;
  }
  res.status(up.status);
  res.setHeader("Content-Type", up.headers.get("content-type") || "application/json");
  const reader = up.body.getReader();
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); } } catch {}
  res.end();
}
