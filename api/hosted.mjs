// Hosted Overlap on Vercel (one deployment, many pages at /u/<id>/). vercel.hosted.json
// rewrites /api/pages and /u/<id>/api/* here, passing the original path in ?p=.
import { HostedPages } from "../core/hosted.mjs";
import { storeFromEnv } from "../core/store.mjs";

let pages = null;
function load() {
  if (pages) return pages;
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.UPSTASH_REDIS_REST_URL) throw new Error("Hosted Overlap needs a Vercel Blob store (BLOB_READ_WRITE_TOKEN) or Upstash Redis");
  pages = new HostedPages({ registry: storeFromEnv("registry"), storeFor: (id) => storeFromEnv(`page-${id}`) });
  return pages;
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const path = url.searchParams.get("p") || url.pathname;
  url.searchParams.delete("p");
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const origin = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers["x-forwarded-host"] || req.headers.host}`;
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const out = await load().handle({ method: req.method, path, query: Object.fromEntries(url.searchParams), headers: req.headers, body: body || {}, ip, origin });
  res.setHeader("Cache-Control", "no-store");
  if (out.ics) { res.setHeader("Content-Type", "text/calendar; charset=utf-8"); res.status(200).send(out.ics); return; }
  if (/\/api\/(profile|key)$/.test(path)) res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(out.status).send(JSON.stringify(out.body));
}
