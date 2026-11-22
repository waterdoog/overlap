// Talks to this page's own server (same origin). Used by the page, the page's actions,
// the bridge that other agent sites load, and the request window.
// The owner's calendar never reaches the browser of anyone but the owner.

// Keyed by page address: several pages can share one origin when hosted under /u/<id>/.
const OWNER_KEY = `overlap-owner-key:${new URL("../", import.meta.url).pathname}`;

export class Api {
  static base = new URL("../", import.meta.url);

  static url(path) {
    return new URL(path.replace(/^\//, ""), Api.base).href;
  }

  static ownerKey() {
    try { return localStorage.getItem(OWNER_KEY) || ""; } catch { return ""; }
  }

  static setOwnerKey(value) {
    try {
      if (value) localStorage.setItem(OWNER_KEY, value);
      else localStorage.removeItem(OWNER_KEY);
    } catch {}
  }

  static async call(method, path, body, { owner = false } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (owner) headers.Authorization = `Bearer ${Api.ownerKey()}`;
    const response = await fetch(Api.url(path), {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store",
    });
    let data = null;
    try { data = await response.json(); } catch {}
    if (response.status === 401) return { ok: false, reason: "Only the page's owner can do this. Sign in as the owner first." };
    if (!data) throw new Error(`The page's server answered ${response.status}.`);
    return data;
  }

  static profile() { return Api.call("GET", "/api/profile"); }

  static check({ windows, purpose }, callerOrigin, assertion = "") {
    return Api.call("POST", "/api/check", { windows, purpose, caller_origin: callerOrigin, assertion });
  }

  static request(args, details, callerOrigin, assertion = "") {
    return Api.call("POST", "/api/request", { ...args, ...details, caller_origin: callerOrigin, assertion });
  }

  static async assertion(aud) {
    const r = await Api.call("POST", "/api/owner/assertion", { aud }, { owner: true });
    return r.ok ? r.assertion : "";
  }

  static grant(body) { return Api.call("POST", "/api/owner/grant", body, { owner: true }); }

  static status(reference) {
    return Api.call("GET", `/api/request-status?ref=${encodeURIComponent(reference)}`);
  }

  static overview() { return Api.call("GET", "/api/owner/overview", undefined, { owner: true }); }

  static free({ from, to, minutes }) {
    const q = new URLSearchParams({ from, to, minutes: String(minutes) });
    return Api.call("GET", `/api/owner/free?${q}`, undefined, { owner: true });
  }

  static decide(ref, decision) { return Api.call("POST", "/api/owner/decide", { ref, decision }, { owner: true }); }

  static settings(body) { return Api.call("POST", "/api/owner/settings", body, { owner: true }); }

  static reset() { return Api.call("POST", "/api/owner/reset", {}, { owner: true }); }
}

// Shared input schema for a list of windows, used by the page and the bridge.
export const WINDOWS_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: 6,
  description: "Up to 6 exact windows, each with start and end as ISO 8601 UTC times on a quarter hour, such as 2026-11-26T14:30:00Z.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["start", "end"],
    properties: {
      start: { type: "string", description: "Start, ISO 8601 UTC, such as 2026-11-26T14:30:00Z." },
      end: { type: "string", description: "End, ISO 8601 UTC." },
    },
  },
};
