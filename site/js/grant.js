// The browser half of signed caller assertions (core/grants.mjs).
//
// In another page's bridge frame or request window (this page's code, running inside the
// asking person's browser): say hello to the asking page and keep the assertion it sends.
// On the asking person's own page: answer hellos from the pages on their People list with an
// assertion from their own server, but only while they are signed in as the owner.
// Assertions travel by postMessage between the two pages; no agent or model sees them.

const PROTOCOL = "overlap-grant/v1";
const OWN_BASE = new URL("../", import.meta.url).href.replace(/\/$/, "");

const received = new Map(); // asking page origin -> assertion
let waiters = [];

export function helloTo(target) {
  if (!target || target === window) return;
  window.addEventListener("message", (event) => {
    const d = event.data;
    if (d?.protocol !== PROTOCOL || d.type !== "assertion" || typeof d.assertion !== "string") return;
    if (event.source !== target) return;
    received.set(event.origin, d.assertion);
    const ws = waiters; waiters = [];
    for (const w of ws) w();
  });
  // No secret in a hello, so any origin may receive it; the reply is checked on our server.
  target.postMessage({ protocol: PROTOCOL, type: "hello", aud: OWN_BASE }, "*");
}

/** The assertion from the asking page, waiting briefly for it to arrive. */
export async function assertionFrom(callerOrigin, waitMs = 1500) {
  const deadline = Date.now() + waitMs;
  while (!received.has(callerOrigin) && Date.now() < deadline) {
    await new Promise((resolve) => { waiters.push(resolve); setTimeout(resolve, 150); });
  }
  return received.get(callerOrigin) || "";
}

/**
 * On the asking person's page: answer hellos.
 * :param opts: {people: () => [{origin, networkUrl}], isOwner: () => bool, fetchAssertion: async (aud) => token}
 */
export function serveAssertions({ people, isOwner, fetchAssertion }) {
  window.addEventListener("message", async (event) => {
    const d = event.data;
    if (d?.protocol !== PROTOCOL || d.type !== "hello" || typeof d.aud !== "string") return;
    if (!isOwner()) return;
    let aud;
    try { aud = new URL(d.aud); } catch { return; }
    if (aud.origin !== event.origin) return;
    const person = people().find((p) => p.origin === event.origin && d.aud.startsWith(p.networkUrl.replace(/\/overlap_pass$/, "")));
    if (!person) return;
    const token = await fetchAssertion(d.aud).catch(() => "");
    if (token) event.source?.postMessage({ protocol: PROTOCOL, type: "assertion", assertion: token }, event.origin);
  });
}
