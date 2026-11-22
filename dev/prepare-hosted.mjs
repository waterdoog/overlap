// Lays out the hosted site for deployment: hosted-out/ = the start page + site/ (served at
// /u/<id>/ by the rewrites in vercel.hosted.json). Then deploy with that config:
//   node dev/prepare-hosted.mjs && cp vercel.hosted.json vercel.json && vercel deploy --prod
import { cpSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT = join(ROOT, "hosted-out");
rmSync(OUT, { recursive: true, force: true });
cpSync(join(ROOT, "hosted"), OUT, { recursive: true });
cpSync(join(ROOT, "site"), join(OUT, "site"), { recursive: true, dereference: true });
console.log(`hosted-out ready: ${OUT}`);
