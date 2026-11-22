// Registers this page's operations with the agent runtime (agent-manifest.json
// "actions.module"). Only names in "actions.agentTools" become website_* tools.
import { App } from "./app.js";
import { WINDOWS_SCHEMA } from "./js/api.js";
import { RequestWindow } from "./bridge/request-window.js";

const page = () => App.page;

class SiteActions {
  static registerActions(actions) {
    actions.register({
      name: "get_profile",
      description: "Read this page: whose page it is (name, role, time zone, usual hours, topics), the rules it follows when asked about availability, whether the visitor is the page's owner, the current UTC time, and (for the owner) the people they invited, each with the person_N tool that asks that person's page. Call it first in every turn.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => page().getProfile(),
    });
    actions.register({
      name: "check_windows",
      description: "For a visitor: ask whether the page's owner is free for up to 6 exact windows. Answers yes or no per window (plus up to two nearby free windows in helpful mode). Each window uses the daily budget, so ask only about windows the visitor would book.",
      effect: "read",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["windows"],
        properties: { windows: WINDOWS_SCHEMA, purpose: { type: "string", maxLength: 120, description: "What the meeting is about, in a few words." } },
      },
      execute: (args) => page().checkWindows(args),
    });
    actions.register({
      name: "request_meeting",
      description: "For a visitor: send the page's owner a meeting request for one window check_windows said is free. A form opens where the visitor types their own name and email, so never ask for them. Stays pending until the owner accepts. Returns the reference.",
      effect: "irreversible",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["start", "end", "title"],
        properties: {
          start: { type: "string", description: "Start, ISO 8601 UTC on a quarter hour." },
          end: { type: "string", description: "End, ISO 8601 UTC." },
          title: { type: "string", minLength: 1, maxLength: 100, description: "Short meeting title. No names or emails." },
        },
      },
      execute: SiteActions.requestHere,
    });
    actions.register({
      name: "request_status",
      description: "Read the status of a meeting request sent to this page's owner, by reference (OV-xxxxxx).",
      effect: "read",
      inputSchema: { type: "object", additionalProperties: false, required: ["reference"], properties: { reference: { type: "string", minLength: 9, maxLength: 9, description: "The reference, such as OV-3F2A1C." } } },
      execute: (args) => page().requestStatus(args),
    });
    actions.register({
      name: "my_free_time",
      description: "Owner only: read the owner's own free blocks in a date range, from their private calendar. Never send these blocks to anyone.",
      effect: "read",
      inputSchema: {
        type: "object", additionalProperties: false,
        properties: {
          from: { type: "string", description: "Range start, ISO 8601 UTC. Default now." },
          to: { type: "string", description: "Range end, ISO 8601 UTC. Default 7 days later." },
          minutes: { type: "integer", minimum: 15, maximum: 120, description: "Meeting length." },
        },
      },
      execute: (args) => page().myFreeTime(args),
    });
    actions.register({
      name: "candidate_windows",
      description: "Owner only: pick up to 6 windows to ask the invited people about: inside the owner's free time and every invited person's usual hours, spread over days, never repeating a window already asked in this visit. Call it before asking any person_N tool about times, and again for more windows when none worked.",
      effect: "read",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["minutes"],
        properties: {
          minutes: { type: "integer", minimum: 15, maximum: 120, description: "Meeting length in minutes." },
          from: { type: "string", description: "Earliest start, ISO 8601 UTC. Default now." },
          to: { type: "string", description: "Latest end, ISO 8601 UTC. Default 7 days after from." },
          people: { type: "array", items: { type: "string", enum: App.SLOTS }, description: "Which invited people (person_N tools). Default all." },
        },
      },
      execute: (args) => page().candidateWindows(args),
    });
  }

  // The page's own request form, in a dialog. It is the confirmation: the visitor sees
  // what will be sent and types their details, which never pass through the agent.
  static async requestHere(args) {
    const profile = page().profile;
    const dialog = document.createElement("dialog");
    dialog.className = "request-dialog";
    document.body.append(dialog);
    const result = await new Promise((resolve) => {
      RequestWindow.show({ args, profile, caller: location.host, callerOrigin: location.origin, container: dialog, done: false }, resolve);
      dialog.addEventListener("cancel", (e) => { e.preventDefault(); });
      dialog.showModal();
    });
    setTimeout(() => { dialog.close(); dialog.remove(); page().refreshOwner(); }, result.ok ? 1800 : 900);
    return result;
  }
}

export const registerActions = SiteActions.registerActions;
