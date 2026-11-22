// Mounts the assistant inside the existing page. Load it with:
//   <script type="module" src="site.js"></script>
// The page needs the mount markup from assistant-section.html.
// Mounts the runtime for Overlap. Adapted from the agentify-website template (Apache-2.0).
// Additions: binds the person_N link slots to the owner's People list, names each
// person on the consent card, and lets request_meeting use its own form as confirmation.
import { App } from "./app.js";
import { Api } from "./js/api.js";
import { serveAssertions } from "./js/grant.js";

// Pages on the owner's People list may ask for a signed assertion that this page (and its
// owner) is the one asking. Their bridge frames and request windows say hello; only the
// owner's page answers, and only for those pages.
serveAssertions({ people: () => App.page.people, isOwner: () => App.page.owner, fetchAssertion: (aud) => Api.assertion(aud) });

/**
 * Boots the browser runtime in the page's assistant section.
 *
 * It points the runtime at this folder, so the manifest, network and actions load from
 * the same place as the page. Before each irreversible action, it shows its own
 * confirmation dialog, written for the visitor.
 */
export class AssistantMount {
  /**
   * The first chat message once the visitor has a key: what the assistant can do here.
   */
  static get GREETING() {
    const p = App.page;
    const first = (p.profile?.name || "this person").split(" ")[0];
    if (p.owner) {
      return p.people.length
        ? `Hi ${first}. Ask me to find a time with ${AssistantMount.names(p.people.map((x) => x.name.split(" ")[0]))}: I ask each of their pages yes-or-no questions, and nobody's calendar leaves its owner.`
        : `Hi ${first}. Add people's Overlap pages under People, then ask me to find a time with them.`;
    }
    return `I'm ${first}'s assistant. Ask whether ${first} is free at a time that suits you, and I can send ${first} a meeting request. I can't show ${first}'s calendar: this page answers only yes or no.`;
  }

  /**
   * The confirmation dialog's words for each irreversible action. Name each button after
   * what it does, so that "Cancel" never has two meanings. With no irreversible action,
   * leave this empty.
   */
  static DIALOGS = {};

  /**
   * Actions whose own form is the confirmation: the visitor sees what is sent and types
   * their details there, so a second dialog would only repeat it.
   */
  static OWN_FORM = new Set(["request_meeting"]);

  /**
   * Boot the runtime and report the result in the status line.
   *
   * :return: The runtime engine, or null when boot failed.
   */
  static async start() {
    const status = document.querySelector("#assistant-status");
    const siteBase = new URL("./", import.meta.url).href;
    try {
      // Load the runtime here, so a missing or broken runtime is reported too.
      const { boot } = await import("./runtime/index.js");
      const booted = await boot("#agent-app", {
        originUrl: siteBase,
        sandboxWorkerUrl: new URL("runtime/sandbox-worker.js", siteBase).href,
      });
      AssistantMount.engine = booted.engine;
      window.overlapEngine = booted.engine;
      AssistantMount.bindPeople();
      App.page.onChange(() => AssistantMount.bindPeople());
      // People are added on the page, never typed into the chat: an unbound person_N slot
      // answers "not linked" to the agent instead of asking the visitor for a URL.
      booted.engine.onLinkRequired = async () => null;
      AssistantMount.relabel();
      AssistantMount.consentForSameSitePages();
      AssistantMount.defaultReview = booted.engine.onActionConfirm;
      booted.engine.onActionConfirm = AssistantMount.review;
      AssistantMount.defaultConsent = booted.engine.onConsent;
      booted.engine.onConsent = AssistantMount.consent;
      // Without a key the chat cannot answer yet. This is the same test as the
      // runtime's "API key required" badge in runtime/ui.js.
      const needsKey = !booted.engine.mockLLM
        && (!booted.engine.byokKey || booted.engine.byokKey === "demo");
      status.textContent = needsKey
        ? "Assistant needs your AI provider key. Add it in AI model settings below."
        : "Assistant connected to this page.";
      if (!needsKey) {
        AssistantMount.greet();
      }
      return booted.engine;
    } catch (error) {
      // The page must keep working without the assistant.
      status.textContent = "The assistant could not load. You can still use the page directly.";
      console.error("Assistant startup failed", error);
      return null;
    }
  }

  /**
   * The runtime labels partners by their manifest brand ("Overlap" for everyone) and calls
   * any model "real LLM". Name each person instead, and say plainly when the scripted demo
   * model (no AI) is in use.
   */
  static relabel() {
    const app = document.querySelector("#agent-app");
    if (!app) return;
    const fix = () => {
      for (const node of app.querySelectorAll(".ns-anode")) {
        const addr = node.querySelector(".ns-aaddr")?.textContent || "";
        const person = App.page.people.find((p) => addr && addr.replace(/\s/g, "").startsWith(new URL(p.networkUrl).host + new URL(p.networkUrl).pathname.replace(/\/overlap_pass$/, "")));
        const name = node.querySelector(".ns-aname");
        if (person && name && name.textContent !== `${person.name}'s page`) name.textContent = `${person.name}'s page`;
        const role = node.querySelector(".ns-arole");
        if (role?.textContent === "your concierge" && name && App.page.profile && name.textContent !== `${App.page.profile.name}'s assistant`) name.textContent = `${App.page.profile.name}'s assistant`;
      }
      const badge = app.querySelector(".ns-llmbadge");
      if (badge && AssistantMount.engine?.modelOverride === "scripted" && !badge.textContent.includes("no AI")) {
        badge.textContent = "● scripted demo (no AI)";
        badge.title = "A fixed script on this site plays the model, so you can see the protocol without an AI key.";
      }
    };
    new MutationObserver(fix).observe(app, { childList: true, subtree: true, characterData: true });
    fix();
  }

  /**
   * The runtime asks before contacting another origin, but pages hosted on one site
   * (/u/<id>/) share an origin, so it would contact them without a card. Ask for those too,
   * per page, before their network is loaded. (A wrapper around the engine; the runtime
   * files are unchanged.)
   */
  static consentForSameSitePages() {
    const engine = AssistantMount.engine;
    const own = new URL("./", import.meta.url).href;
    const original = engine.resolveRemote.bind(engine);
    engine.resolveRemote = async (ref, chain, span, manifest) => {
      let target;
      try { target = new URL(ref, location.href); } catch { return original(ref, chain, span, manifest); }
      if (target.origin === location.origin && !target.href.startsWith(own)) {
        const page = target.href.replace(/\/[^/]*$/, "");
        const person = App.page.people.find((p) => p.networkUrl === target.href);
        const decision = await engine.requestConsent({
          kind: "network", peerLabel: person ? `${person.name}'s page` : page.replace(/^https?:\/\//, ""),
          peerOrigin: page.replace(/^https?:\/\//, ""), requestText: "", est: { totalTokens: 0 },
        });
        if (decision === "decline") throw new Error(`The user declined to contact ${page.replace(/^https?:\/\//, "")}.`);
      }
      return original(ref, chain, span, manifest);
    };
  }

  static names(list) {
    return list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  }

  /**
   * Bind each person_N link slot to the network URL of that person on the People list,
   * and allow exactly those origins. The runtime still shows a consent card before it
   * contacts each one, and validates the network it fetches.
   */
  static bindPeople() {
    const engine = AssistantMount.engine;
    const network = engine?.top?.network;
    if (!network) return;
    const base = engine.top.base;
    for (const slot of App.SLOTS) {
      const person = App.page.people.find((p) => p.slot === slot);
      const key = `nsdeploy-link-v1::${base}::${network.name}::${slot}`;
      if (person) {
        network.links[slot] = person.networkUrl;
        // The "Agents working for you" panel names a partner from link_labels.
        network.linkLabels[person.networkUrl] = `${person.name}'s page`;
        engine.runtimeAllowedPeers.add(person.origin);
        try { localStorage.setItem(key, person.networkUrl); } catch {}
      } else {
        delete network.links[slot];
        try { localStorage.removeItem(key); } catch {}
      }
    }
    // Origins no longer on the list lose their allowance.
    for (const origin of [...engine.runtimeAllowedPeers]) {
      if (!App.page.people.some((p) => p.origin === origin)) engine.runtimeAllowedPeers.delete(origin);
    }
  }

  /**
   * Replace the runtime's general first chat message with GREETING. "New chat" keeps the
   * first message, so the greeting stays for the whole visit.
   */
  static greet() {
    const first = document.querySelector("#ns-msgs .ns-msg.bot");
    if (first) {
      first.textContent = AssistantMount.GREETING;
    }
  }

  /**
   * Ask the visitor to confirm actions before they run. One of this page's actions listed
   * in DIALOGS gets this page's dialog. Anything else, such as a partner site's action,
   * gets the runtime's own dialog.
   *
   * :param items: The actions waiting for confirmation, each with action, origin, effect
   *   and arguments.
   * :return: True when the visitor confirms.
   * :raises Error: The site's reason, when its own check refuses the action, or when a
   *   chat form bundles one of this page's DIALOGS actions with other actions.
   */
  static async review(items) {
    let confirmed = false;
    const pageOrigin = new URL(document.URL).origin;
    // This page's dialog shows one action with its details and runs the site's own check.
    // A chat form that bundles such an action with others would skip both, so nothing
    // runs.
    if (items.length > 1) {
      for (const item of items) {
        if (item.origin === pageOrigin && Object.hasOwn(AssistantMount.DIALOGS, item.action)) {
          throw new Error(`Nothing ran. "${AssistantMount.DIALOGS[item.action].confirm}" needs its own confirmation, so ask the assistant to do that on its own.`);
        }
      }
    }
    // A partner's action can have the same name as one of this page's. It gets the
    // runtime's dialog, which names the partner's origin, and this page's check never runs.
    const own = items.length === 1 && items[0].origin === pageOrigin;
    if (own && AssistantMount.OWN_FORM.has(items[0].action)) {
      return true;
    }
    if (own && Object.hasOwn(AssistantMount.DIALOGS, items[0].action)) {
      const content = AssistantMount.dialogContent(items[0]);
      if (content.refusal) {
        // A dialog would offer a button that cannot work. The runtime runs nothing
        // and gives the agent this reason as an "Error from tool" message.
        throw new Error(content.refusal);
      }
      confirmed = await new Promise(AssistantMount.openDialog.bind(null, content));
    } else {
      confirmed = await AssistantMount.defaultReview(items);
    }
    AssistantMount.keepFocusInChat();
    return confirmed;
  }

  /**
   * Ask the visitor, with the runtime's consent card, whether to contact a partner site.
   * Focus the card while it waits, then put focus back in the chat.
   *
   * :param info: What the card shows, such as the partner's label and host and the request.
   * :return: The card's answer, unchanged: "allow", "always" or "decline". The runtime
   *   allows the call when this returns nothing.
   */
  static async consent(info) {
    // The runtime labels a link slot by its name ("person_2"). Name the person instead.
    const person = App.page.people.find((p) => new URL(p.origin).host === info.peerOrigin);
    if (person) info = { ...info, peerLabel: `${person.name}'s page` };
    // defaultConsent() adds the card at once. The card has no role, and the stylesheet
    // hides the status line while it waits, so name the card and focus its title.
    const answer = AssistantMount.defaultConsent(info);
    AssistantMount.focusConsentCard();
    const decision = await answer;
    // Answering the card removes its buttons, so focus may fall to the page body.
    AssistantMount.keepFocusInChat();
    return decision;
  }

  /**
   * Name the newest consent card after its title, for screen readers. Move focus to that
   * title when focus is in the chat or on the page body, not from the page's own form.
   */
  static focusConsentCard() {
    const cards = document.querySelectorAll("#ns-msgs .ns-consent");
    const card = cards[cards.length - 1];
    const title = card ? card.querySelector(".ns-consent-title") : null;
    if (!title) {
      return;
    }
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", title.textContent);
    // A visitor typing in the page's own form keeps focus, and their keystrokes.
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest("#agent-app")) {
      return;
    }
    // tabIndex -1 lets the title take focus. Enter cannot activate a title, so a stray
    // Enter answers nothing.
    title.tabIndex = -1;
    title.focus();
  }

  /**
   * Work out what the dialog says for one action: its words from DIALOGS, the readable
   * details and the exact call. This is plain data, so tests can check it.
   *
   * :param item: An action waiting for confirmation, with action, origin, effect and
   *   arguments.
   * :return: The title, sentence, button labels, details, exact call text and the
   *   site's refusal, if any.
   */
  static dialogContent(item) {
    let details = {};
    try {
      details = AssistantMount.reviewDetails(item.action, item.arguments) || {};
    } catch (error) {
      // The dialog then opens the exact call, and the visitor decides.
      console.error("Could not add details to the confirmation dialog", error);
    }
    return {
      ...AssistantMount.DIALOGS[item.action],
      details: details,
      refusal: details.refusal,
      exact: `${item.action} on ${item.origin} (${item.effect})\n${JSON.stringify(item.arguments, null, 2)}`,
    };
  }

  /**
   * Give the readable details of one irreversible action, such as items, total, name,
   * email and what undoing it would cost, from the page's own read-only operations, so
   * no rule is copied here. When the operation's own check refuses the call, return
   * {refusal: reason}, and review() opens no dialog.
   *
   * :param action: The action name.
   * :param args: The action's arguments.
   * :return: Details by label, {refusal: reason}, or {} when the action has none.
   */
  static reviewDetails(action, args) {
    return {};
  }

  /**
   * Open the confirmation dialog: a question, a plain sentence, the readable details,
   * the exact call under "Technical details", and two buttons.
   *
   * :param content: What the dialog says, from dialogContent().
   * :param resolve: Receives true when the visitor confirms, and false otherwise.
   */
  static openDialog(content, resolve) {
    const dialog = document.createElement("dialog");
    dialog.className = "assistant-review";
    dialog.setAttribute("aria-labelledby", "assistant-review-title");
    const heading = document.createElement("h2");
    heading.id = "assistant-review-title";
    heading.textContent = content.title;
    // Start on the heading, which Enter cannot activate, so a stray Enter confirms nothing.
    heading.tabIndex = -1;
    heading.autofocus = true;
    const sentence = document.createElement("p");
    sentence.textContent = content.sentence;
    dialog.append(heading, sentence);
    const exact = document.createElement("details");
    const exactLabel = document.createElement("summary");
    exactLabel.textContent = "Technical details";
    const exactText = document.createElement("pre");
    exactText.textContent = content.exact;
    exact.append(exactLabel, exactText);
    const entries = Object.entries(content.details);
    if (entries.length) {
      const list = document.createElement("dl");
      for (const [label, value] of entries) {
        const term = document.createElement("dt");
        term.textContent = label;
        const description = document.createElement("dd");
        description.textContent = String(value);
        list.append(term, description);
      }
      dialog.append(list);
    } else {
      // Without readable details, open the exact call, so the visitor still sees it.
      exact.open = true;
    }
    const confirmButton = document.createElement("button");
    confirmButton.textContent = content.confirm;
    confirmButton.addEventListener("click", dialog.close.bind(dialog, "confirm"));
    const declineButton = document.createElement("button");
    declineButton.className = "assistant-decline";
    declineButton.textContent = content.decline;
    declineButton.addEventListener("click", dialog.close.bind(dialog, "decline"));
    // Escape also closes the dialog, without "confirm".
    dialog.addEventListener("close", AssistantMount.finishDialog.bind(null, dialog, resolve));
    dialog.append(exact, confirmButton, declineButton);
    document.body.append(dialog);
    dialog.showModal();
  }

  /**
   * Remove the closed dialog and report the visitor's choice.
   *
   * :param dialog: The dialog that just closed.
   * :param resolve: Receives true when the visitor pressed the confirm button.
   */
  static finishDialog(dialog, resolve) {
    dialog.remove();
    resolve(dialog.returnValue === "confirm");
  }

  /**
   * Put focus back in the chat input when a dialog or the consent card left it on the
   * page body. A chat form disables its controls when it is sent, so focus can fall to
   * the body, and the next Tab would start at the top of the page.
   */
  static keepFocusInChat() {
    if (document.activeElement === document.body || document.activeElement === null) {
      document.querySelector("#ns-input")?.focus();
    }
  }
}

// Boot only in a browser. Node tests import this file to check the dialog's words.
if (typeof window !== "undefined") {
  await App.page.ready;
  await freeModelByDefault();
  await AssistantMount.start();
}

/**
 * On a demo page, a visitor with no model settings starts on this site's free model, the
 * same setup the demo bar's "Free AI model" button applies, only for this tab and without
 * a reload. Saved settings, or a setup already applied in this tab, always win.
 */
async function freeModelByDefault() {
  if (!App.page.profile?.demo) return;
  try {
    if (localStorage.getItem("nsweb-byok-profiles-v1") || sessionStorage.getItem("nsweb-byok-router") !== null) return;
    const models = await fetch("llm/v1/models").then((r) => (r.ok ? r.json() : null));
    const id = models?.data?.[0]?.id;
    if (!id) return;
    sessionStorage.setItem("nsweb-byok-tab-key", "free-demo");
    sessionStorage.setItem("nsweb-byok-model", id);
    sessionStorage.setItem("nsweb-byok-router", `${location.origin}/llm/v1`);
  } catch {
    // No storage or no free model: the visitor connects one in AI model settings.
  }
}
