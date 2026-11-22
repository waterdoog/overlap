// Hosted entry point (Vercel Node function) for one person's Overlap page.
// Static files are served from site/ (see vercel.json); this handles /api/*.
import { OwnerServer } from "../core/api.mjs";
import { storeFromEnv } from "../core/store.mjs";

let server = null;

function load() {
  if (server) return server;
  const profile = JSON.parse(process.env.PASS_PROFILE || "{}");
  delete profile.dev_owner_key;
  if (!profile.name || !profile.timezone) throw new Error("PASS_PROFILE needs at least name and timezone");
  const store = storeFromEnv(profile.id || "me"); // Blob, Redis, or memory (demo only)
  server = new OwnerServer({ profile, store, ownerKey: process.env.OWNER_KEY });
  return server;
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
  const out = await load().handle({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: body || {}, ip, base: `${req.headers["x-forwarded-proto"] || "https"}://${req.headers["x-forwarded-host"] || req.headers.host}` });
  if (out.ics) { res.setHeader("Content-Type", "text/calendar; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.status(200).send(out.ics); return; }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (["/api/profile", "/api/key"].includes(url.pathname)) res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(out.status).send(JSON.stringify(out.body));
}
