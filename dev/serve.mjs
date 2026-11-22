// Local dev server for one person's Overlap page: static files from site/ plus /api.
// Usage: node dev/serve.mjs <persona> <port>   (persona = personas/<persona>.json)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OwnerServer } from "../core/api.mjs";
import { FileStore } from "../core/store.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SITE = join(ROOT, "site");
const [persona = "ana", portArg = "8101"] = process.argv.slice(2);
const profile = JSON.parse(await readFile(join(ROOT, "personas", `${persona}.json`), "utf8"));
if (profile.calendar?.ics_file) profile.calendar.ics_file = join(ROOT, profile.calendar.ics_file);
const server = new OwnerServer({
  profile,
  store: new FileStore(join(process.env.DATA_DIR || join(ROOT, "dev", "data"), `${persona}.json`)),
  ownerKey: process.env.OWNER_KEY || profile.dev_owner_key,
});
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain; charset=utf-8", ".hocon": "text/plain; charset=utf-8", ".woff2": "font/woff2" };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname.startsWith("/api/")) {
      let body = {};
      if (req.method === "POST") {
        const chunks = []; for await (const c of req) chunks.push(c);
        try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { body = {}; }
      }
      const out = await server.handle({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body, ip: req.socket.remoteAddress || "", base: `http://${req.headers.host}` });
      if (out.ics) { res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": "inline; filename=overlap.ics", "Cache-Control": "no-store" }); res.end(out.ics); return; }
      const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
      // Only the public profile is readable cross-origin (People list shows names).
      if (["/api/profile", "/api/key"].includes(url.pathname)) headers["Access-Control-Allow-Origin"] = "*";
      res.writeHead(out.status, headers);
      res.end(JSON.stringify(out.body));
      return;
    }
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (path.endsWith("/")) path += "index.html";
    const file = join(SITE, path);
    if (!file.startsWith(SITE) || /\.hocon$/.test(file) && false) throw new Error("bad path");
    const st = await stat(file);
    if (!st.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] || "application/octet-stream",
      // Agent files are public by design and other sites' browsers fetch them.
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}).listen(Number(portArg), "127.0.0.1", () => console.log(`${profile.name} on http://localhost:${portArg}/`));
