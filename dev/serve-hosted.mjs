// Local dev server for hosted Overlap: many pages on one origin at /u/<id>/, created from
// the start page at /. Usage: node dev/serve-hosted.mjs [port] [--allow-private-calendars]
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HostedPages } from "../core/hosted.mjs";
import { FileStore } from "../core/store.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SITE = join(ROOT, "site");
const START = join(ROOT, "hosted");
const PORT = Number(process.argv[2] || 8200);
const DATA = process.env.DATA_DIR || join(ROOT, "dev", "data-hosted");
const pages = new HostedPages({
  registry: new FileStore(join(DATA, "registry.json")),
  storeFor: (id) => new FileStore(join(DATA, `page-${id}.json`)),
  allowPrivateCalendarHosts: process.argv.includes("--allow-private-calendars"),
});
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".ics": "text/calendar; charset=utf-8" };

async function sendFile(res, dir, rel) {
  let p = normalize(decodeURIComponent(rel)).replace(/^(\.\.[/\\])+/, "");
  if (p === "." || p === "") p = "index.html";
  else if (p.endsWith("/")) p += "index.html";
  const file = join(dir, p);
  if (!file.startsWith(dir) || !(await stat(file).catch(() => null))?.isFile()) { res.writeHead(404); res.end("Not found"); return; }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
  res.end(await readFile(file));
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const origin = `http://${req.headers.host}`;
  try {
    if (url.pathname === "/api/pages" || /^\/u\/[^/]+\/api\//.test(url.pathname)) {
      let body = {};
      if (req.method === "POST") { const c = []; for await (const x of req) c.push(x); try { body = JSON.parse(Buffer.concat(c).toString() || "{}"); } catch {} }
      const out = await pages.handle({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body, ip: req.socket.remoteAddress || "", origin });
      if (out.ics) { res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store" }); res.end(out.ics); return; }
      const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
      if (/\/api\/(profile|key)$/.test(url.pathname)) headers["Access-Control-Allow-Origin"] = "*";
      res.writeHead(out.status, headers); res.end(JSON.stringify(out.body)); return;
    }
    const m = /^\/u\/([a-z0-9-]{3,40})(\/.*)?$/.exec(url.pathname);
    if (m) {
      if (!m[2]) { res.writeHead(301, { Location: `/u/${m[1]}/` }); res.end(); return; }
      return sendFile(res, SITE, m[2].slice(1));
    }
    return sendFile(res, START, url.pathname.slice(1));
  } catch (e) {
    console.error(e); res.writeHead(500); res.end("error");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`hosted Overlap on http://localhost:${PORT}/`));
