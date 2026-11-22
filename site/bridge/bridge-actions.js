// What this page shares with other agent sites, through its action bridge.
// When another site's assistant runs this page's overlap_pass network, the bridge runs
// these in a hidden frame on THIS origin, and they call this page's own server.
// The server enforces the answer rule and the disclosure budget, so it is safe to share
// them with every site ("*"): a caller learns yes or no for the windows it asks about,
// within its budget, and never the calendar.
import { Api, WINDOWS_SCHEMA } from "../js/api.js";
import { RequestWindow } from "./request-window.js";
import { assertionFrom, helloTo } from "../js/grant.js";

// This module runs in this page's bridge frame inside the asking person's browser. Ask the
// asking page for a signed assertion, so this page's server knows which page is asking.
if (typeof window !== "undefined" && window.parent !== window) helloTo(window.parent);

class BridgeActions {
  static CALLERS = ["*"];

  static registerActions(actions) {
    actions.register(BridgeActions.profileAction());
    actions.register(BridgeActions.checkAction());
    actions.register(BridgeActions.statusAction());
    actions.register(RequestWindow.definition());
  }

  static profileAction() {
    return {
      name: "get_profile",
      description: "Read this person's public profile: name, role, organisation, time zone, usual hours, topics, and the rules their page follows when agents ask about availability. Changes nothing.",
      effect: "read",
      availability: "bridge",
      callerOrigins: BridgeActions.CALLERS,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => Api.profile(),
    };
  }

  static checkAction() {
    return {
      name: "check_windows",
      description: "Ask whether this person is free for each of up to 6 exact windows. Answers only yes or no per window (and, if their page allows, up to two nearby free windows when none is free). Each window asked uses the asking site's daily budget, so ask only about windows you would really book. Never returns their calendar.",
      effect: "read",
      availability: "bridge",
      callerOrigins: BridgeActions.CALLERS,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["windows"],
        properties: {
          windows: WINDOWS_SCHEMA,
          purpose: { type: "string", maxLength: 120, description: "What the meeting is about, in a few words. No names or emails." },
        },
      },
      execute: async (args, context) => Api.check(args, context?.callerOrigin, await assertionFrom(context?.callerOrigin)),
    };
  }

  static statusAction() {
    return {
      name: "request_status",
      description: "Read the status (pending, accepted or declined) of a meeting request by its reference, such as OV-3F2A1C.",
      effect: "read",
      availability: "bridge",
      callerOrigins: BridgeActions.CALLERS,
      inputSchema: {
        type: "object", additionalProperties: false, required: ["reference"],
        properties: { reference: { type: "string", minLength: 9, maxLength: 9, description: "The reference, such as OV-3F2A1C." } },
      },
      execute: (args) => Api.status(args.reference),
    };
  }
}

export const registerActions = BridgeActions.registerActions;
