// Signed caller assertions: how Bo's page knows, for certain, that a question came from
// Ana's page and was sent by Ana.
//
// Each page has an Ed25519 key derived from its owner key; the public half is published at
// <page>/api/key. When Ana (signed in as owner) lets her assistant ask Bo's page, her page asks
// its own server for an assertion {iss: Ana's page, aud: Bo's page, exp: +10 min} and hands
// it, by postMessage, to Bo's bridge frame (Bo's code, on Bo's origin, inside Ana's browser).
// Bo's bridge sends it with the question; Bo's server checks the signature against Ana's
// published key. The model never sees the assertion.
//
// A verified page gets its own budget, and the owner can grant it more or block it. Anything
// unverified (a visitor, or a script that claims an origin) shares a small anonymous pool, so
// it can neither impersonate a page nor use up the budget pages get.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const MAX_LIFETIME_MS = 15 * 60000;
const b64u = (buf) => Buffer.from(buf).toString("base64url");

export function pageBase(url) {
  const u = new URL(url);
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

export class PageKey {
  /**
   * :param secret: the owner key (self-hosted page) or a random server-side seed (hosted page).
   */
  constructor(secret) {
    const seed = createHash("sha256").update(`overlap-signing:${secret}`).digest();
    this.privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
    this.publicRaw = createPublicKey(this.privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  }

  publicJwk() { return { alg: "Ed25519", x: b64u(this.publicRaw) }; }

  assert({ iss, aud, now, ttlMs = 10 * 60000 }) {
    const payload = { v: 1, iss: pageBase(iss), aud: pageBase(aud), iat: now, exp: now + ttlMs };
    const body = b64u(JSON.stringify(payload));
    return `${body}.${b64u(sign(null, Buffer.from(body), this.privateKey))}`;
  }
}

export class AssertionVerifier {
  /**
   * :param fetchKey: async (issBase) => {alg, x} — fetches <iss>/api/key. Injectable for tests.
   */
  constructor({ fetchKey, now }) {
    this.fetchKey = fetchKey || defaultFetchKey;
    this.now = now || (() => Date.now());
    this.cache = new Map();
  }

  async keyFor(iss) {
    const hit = this.cache.get(iss);
    if (hit && this.now() - hit.at < 10 * 60000) return hit.key;
    const jwk = await this.fetchKey(iss);
    if (jwk?.alg !== "Ed25519" || typeof jwk.x !== "string") throw new Error("no key");
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(jwk.x, "base64url")]), format: "der", type: "spki" });
    this.cache.set(iss, { at: this.now(), key });
    return key;
  }

  /**
   * :return: {page} for a valid assertion addressed to ownBase, else {reason}.
   */
  async check(token, ownBase, claimedOrigin) {
    if (!token) return { reason: "none" };
    const [body, sig] = String(token).split(".");
    let p;
    try { p = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return { reason: "malformed" }; }
    const now = this.now();
    if (p?.v !== 1 || typeof p.iss !== "string" || typeof p.aud !== "string") return { reason: "malformed" };
    if (p.aud !== pageBase(ownBase)) return { reason: "addressed to another page" };
    if (!(p.exp > now) || p.iat > now + 60000 || p.exp - p.iat > MAX_LIFETIME_MS) return { reason: "expired" };
    let iss;
    try { iss = pageBase(p.iss); } catch { return { reason: "malformed" }; }
    if (!/^https?:$/.test(new URL(iss).protocol)) return { reason: "malformed" };
    // The bridge reports the asking page's origin as the browser saw it; it must match.
    if (claimedOrigin && new URL(iss).origin !== claimedOrigin) return { reason: "origin mismatch" };
    try {
      const key = await this.keyFor(iss);
      if (!verify(null, Buffer.from(body), key, Buffer.from(sig || "", "base64url"))) return { reason: "bad signature" };
    } catch { return { reason: "key unavailable" }; }
    return { page: iss };
  }
}

async function defaultFetchKey(iss) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(`${iss}/api/key`, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    return r.ok ? await r.json() : null;
  } finally { clearTimeout(t); }
}
