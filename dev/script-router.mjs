// Local scripted router (see core/script-model.mjs).  node dev/script-router.mjs [port]
import { createServer } from "node:http";
import { MODELS, respond } from "../core/script-model.mjs";

const PORT = Number(process.argv[2] || 8198);
createServer(async (req, res) => {
  // Private-network header: lets a public https page (a live test) call this local router.
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Private-Network": "true" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
  if (req.method === "GET" && req.url.endsWith("/models")) { res.writeHead(200, { ...cors, "Content-Type": "application/json" }); res.end(JSON.stringify(MODELS)); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  const out = respond(body);
  console.log(out.reply.tool ? `-> ${out.reply.tool} ${JSON.stringify(out.reply.args).slice(0, 160)}` : `-> text ${out.reply.text.slice(0, 160)}`);
  if (out.stream) { res.writeHead(200, { ...cors, "Content-Type": "text/event-stream" }); res.end(out.stream); return; }
  res.writeHead(200, { ...cors, "Content-Type": "application/json" });
  res.end(JSON.stringify(out.json));
}).listen(PORT, "127.0.0.1", () => console.log(`scripted router on http://localhost:${PORT}/v1`));
