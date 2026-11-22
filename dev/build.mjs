// Builds both networks with the official agentify-website build script (it parses with
// the runtime's own HOCON parser and runs the runtime's validator plus its lint checks).
// The official build checks networks[0] of the manifest, so overlap_pass is built
// against a temporary manifest that lists it first; overlap_home is built last against
// the real manifest, which writes the discovery files and the action bridge.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SITE = join(ROOT, "site");
const TOOL = process.env.AGENTIFY_BUILD || join(ROOT, "tools", "agentify-website", "scripts", "build_network.mjs");
const manifestPath = join(SITE, "agent-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const check = process.argv.includes("--check") ? ["--check"] : [];

const passFirst = { ...manifest, networks: [manifest.networks[1], manifest.networks[0]], agent_mcp: { ...manifest.agent_mcp, network: "overlap_pass", front_man: "pass_agent" } };
const tmp = join(SITE, ".manifest-pass.json");
writeFileSync(tmp, JSON.stringify(passFirst, null, 2));
let failed = false;
const run = (args) => {
  try { console.log(execFileSync("node", [TOOL, ...args], { encoding: "utf8" })); return true; }
  catch (e) { console.log(e.stdout || ""); console.error(e.stderr || e.message); return false; }
};
console.log("\n== overlap_pass.hocon");
if (check.length) {
  // The discovery files describe overlap_home (the page's network), so build overlap_pass
  // in a scratch copy and compare only its network file.
  const scratch = mkdtempSync(join(tmpdir(), "overlap-build-"));
  cpSync(SITE, scratch, { recursive: true, dereference: true });
  if (!run([join(scratch, "overlap_pass.hocon"), "--manifest", join(scratch, ".manifest-pass.json")])) failed = true;
  const same = readFileSync(join(scratch, "overlap_pass.network.json"), "utf8") === readFileSync(join(SITE, "overlap_pass.network.json"), "utf8");
  console.log(same ? "OK: overlap_pass.network.json is up to date." : "ERROR: overlap_pass.network.json is out of date. Run node dev/build.mjs.");
  if (!same) failed = true;
  rmSync(scratch, { recursive: true, force: true });
} else if (!run([join(SITE, "overlap_pass.hocon"), "--manifest", tmp])) failed = true;
console.log("\n== overlap_home.hocon");
if (!run([join(SITE, "overlap_home.hocon"), "--manifest", manifestPath, ...check])) failed = true;
rmSync(tmp, { force: true });
process.exitCode = failed ? 1 : 0;
