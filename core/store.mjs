// Where an owner's page keeps its receipts and meeting requests.
// FileStore for local development, RedisStore (Upstash REST) for hosting.
// One small JSON document per owner; last write wins, which is fine for one person's page.

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

const EMPTY = () => ({ receipts: [], requests: [] });
const MAX_RECEIPTS = 500;

function trim(state) {
  if (state.receipts.length > MAX_RECEIPTS) state.receipts = state.receipts.slice(-MAX_RECEIPTS);
  return state;
}

export class MemoryStore {
  constructor() { this.state = EMPTY(); }
  async load() { return structuredClone(this.state); }
  async save(state) { this.state = structuredClone(trim(state)); }
}

export class FileStore {
  constructor(path) { this.path = path; this.chain = Promise.resolve(); }
  async load() {
    try { return { ...EMPTY(), ...JSON.parse(await readFile(this.path, "utf8")) }; }
    catch { return EMPTY(); }
  }
  async save(state) {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(trim(state), null, 1));
    await rename(tmp, this.path);
  }
  // Serialize read-modify-write so two questions at once cannot both spend the same budget.
  update(fn) {
    const run = this.chain.then(async () => { const s = await this.load(); const out = await fn(s); await this.save(s); return out; });
    this.chain = run.catch(() => {});
    return run;
  }
}

export class RedisStore {
  constructor({ url, token, key }) { this.url = url.replace(/\/$/, ""); this.token = token; this.key = key; }
  async cmd(args) {
    const r = await fetch(this.url, { method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
    if (!r.ok) throw new Error(`store ${r.status}`);
    return (await r.json()).result;
  }
  async load() {
    const raw = await this.cmd(["GET", this.key]);
    if (!raw) return EMPTY();
    try { return { ...EMPTY(), ...JSON.parse(raw) }; } catch { return EMPTY(); }
  }
  async save(state) { await this.cmd(["SET", this.key, JSON.stringify(trim(state))]); }
}

for (const C of [MemoryStore, RedisStore]) {
  C.prototype.update = async function update(fn) { const s = await this.load(); const out = await fn(s); await this.save(s); return out; };
}

// Vercel Blob (private store), for hosted deployments. One JSON document per page, written
// with the ETag it was read at, so two writers cannot silently overwrite each other.
export class BlobStore {
  constructor({ path, token }) { this.path = path; this.token = token; this.etag = null; }
  async sdk() { return (this._sdk ||= await import("@vercel/blob")); }
  async load() {
    const { get } = await this.sdk();
    const r = await get(this.path, { access: "private", useCache: false, token: this.token }).catch((e) => { if (/not.?found/i.test(String(e?.name || e?.message))) return null; throw e; });
    if (!r || r.statusCode !== 200) { this.etag = null; return EMPTY(); }
    this.etag = r.blob?.etag || r.etag || null;
    const text = await new Response(r.stream).text();
    try { return { ...EMPTY(), ...JSON.parse(text) }; } catch { return EMPTY(); }
  }
  async save(state) {
    const { put } = await this.sdk();
    const out = await put(this.path, JSON.stringify(trim(state)), {
      access: "private", allowOverwrite: true, addRandomSuffix: false, contentType: "application/json", token: this.token,
      ...(this.etag ? { ifMatch: this.etag } : {}),
    });
    this.etag = out?.etag || null;
  }
  async update(fn) {
    for (let attempt = 0; ; attempt++) {
      const s = await this.load();
      const out = await fn(s);
      try { await this.save(s); return out; }
      catch (e) { if (attempt >= 3 || !/precondition|etag|412/i.test(String(e?.message || e))) throw e; }
    }
  }
}

/** The store for a deployment: Vercel Blob, then Upstash Redis, else memory (demo only). */
export function storeFromEnv(key) {
  const env = process.env;
  if (env.BLOB_READ_WRITE_TOKEN) return new BlobStore({ path: `overlap/${key}.json`, token: env.BLOB_READ_WRITE_TOKEN });
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) return new RedisStore({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN, key: `overlap:${key}` });
  return new MemoryStore();
}
