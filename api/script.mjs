// The public scripted demo "model" (core/script-model.mjs), OpenAI-compatible:
// vercel rewrites /v1/* here. Not AI: it follows a fixed script so anyone can watch the
// whole Overlap flow without an AI key.
import { MODELS, respond } from "../core/script-model.mjs";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  const url = new URL(req.url, "http://x");
  const path = url.searchParams.get("p") || url.pathname;
  if (req.method === "GET" && path.endsWith("/models")) { res.status(200).json(MODELS); return; }
  if (req.method !== "POST" || !path.endsWith("/chat/completions")) { res.status(404).json({ error: "not found" }); return; }
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const out = respond(body || {});
  if (out.stream) { res.setHeader("Content-Type", "text/event-stream"); res.status(200).send(out.stream); return; }
  res.status(200).json(out.json);
}
