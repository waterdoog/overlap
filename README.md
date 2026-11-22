# Overlap

**Find a meeting time across people and companies, without anyone handing over their calendar.**

Overlap is a personal page on the open agentic web. Each person runs their own page on their
own origin. Their calendar stays on their own server. Other people's assistants can ask the page
one kind of question, *"is this person free at these exact times?"*, and get back yes or no,
nothing else, within a daily budget. To find a time with Bo and Cy, Ana's assistant asks
Bo's page and Cy's page, in Ana's browser, on Ana's own AI key, after Ana approves each contact.

- No calendar sharing, no free/busy feed, no central scheduling service, no account.
- The rule "answer only what was asked" is enforced by each owner's server, not by a prompt.
- Every question leaves a receipt the owner can read: who asked, which times, what was answered.

**Live:** [Ana's page](https://overlap-ana.vercel.app/) · [Bo's page](https://overlap-bo.vercel.app/) ·
[Cy's page](https://overlap-cy.vercel.app/) (three origins; the demo bar signs you in and has a
no-key scripted demo) · [Get your own page](https://overlap-pages.vercel.app/)

Built on the [Open Agentic Web MVP spec](https://github.com/cognizant-ai-labs/agentic-web/blob/main/docs/worldwide_agentic_web_mvp_spec.md)
(Profile 0.3) and its reference browser runtime.

## Why

Scheduling across organisations today means one of three things: someone shares a free/busy view
(which shows every busy block of their week), someone sends a booking link (same thing, as a grid),
or two humans play email ping-pong. Calendar sharing across companies is usually switched off by
policy, so people fall back to ping-pong. Agents could do the ping-pong, but only if one person's
agent can ask another person's agent narrow questions without either side exposing its owner's week.

That is exactly what the open agentic web's peer loading is for: Bo's published agent network runs
in Ana's browser on Ana's key, and the only things it can do are the actions Bo's page chooses to share.
Overlap makes Bo's page share one read, *check these windows*, and enforces on Bo's server that the
read discloses as little as possible.

## What it does

| Who | What they do | What happens |
|---|---|---|
| Ana (owner of her page) | "Find 30 minutes next week with Bo and Cy for a pricing sync." | Her assistant picks up to 6 windows inside her own free time and inside Bo's and Cy's published usual hours, then asks Bo's page and Cy's page about exactly those windows. A consent card names each page before it is contacted. It shows a table of yes/no answers and the window that works for everyone. |
| Ana | "Send both of them a request for that time." | Each request opens a window **on Bo's (or Cy's) own origin**, where Ana types her name and email. They never pass through any agent. The request stays pending until Bo accepts it on his page. |
| Any visitor to Bo's page | "Is Bo free Thursday at 15:30 my time?" | The page answers yes or no for that time, and can send Bo a request. It will not describe Bo's calendar. |
| Bo | Opens his page as owner | Sees every question asked about him (site, times, answers), every request, a daily budget meter, and a switch between *strict* (yes/no only) and *helpful* (yes/no, plus up to two nearby free times when none asked was free). |

## How it uses the open agentic web spec

Each Overlap page publishes **two agent networks** in one `agent-manifest.json`:

- `overlap_home` — the assistant on the page (front agent `overlap_assistant`). For the owner it
  coordinates other people's pages through runtime **link slots** `person_1..3`, bound from the
  owner's People list (spec §3.3: caller-owned bindings stored in origin-scoped browser storage,
  never written to the publisher's `links.json`).
- `overlap_pass` — the public network other sites load (front agent `pass_agent`). It has no
  coordination ability at all: it can only call the four actions this page's **action bridge**
  shares (`get_profile`, `check_windows`, `request_status`, and the write `request_meeting`).

| Spec requirement (§6 interoperability checks) | In Overlap |
|---|---|
| Two-agent HOCON network + manifest on ordinary HTTPS | Both networks are HOCON sources (`site/*.hocon`), built to `*.network.json` with the runtime's own parser and validator; static files plus one small `/api` function |
| Run with the site's default router; BYOK path | Default router is hosted Otari; the ⚙ panel takes any OpenAI-compatible router, OpenRouter sign-in, Google AI Studio, etc. |
| Internal agent + grounded capability via a registered site action | `website_*` tools are site actions (`site-actions.js`) backed by the owner's server |
| After approval, load an exact named network from a second origin and run it locally | Ana's page loads `https://bo.example/overlap_pass` after a consent card naming *Bo Okafor's page*; it runs in Ana's browser |
| Second site never receives the user key, cannot change the router | The peer runs on the caller's router and model (runtime `selectPeerRouter`); Bo's server only ever sees the windows asked |
| Private context absent at the peer unless allowed | The owner key lives in the owner's browser and is used only by site actions on the owner's own origin; peers receive only the request text |
| Invalid network, cycle, over-budget, denied origin fail visibly | Runtime checks, plus Overlap's own: over-budget questions are refused whole with a reason; origins not on the People list are refused by `peer_policy: closed` |
| Writes: user-owned confirmation, receipts | The request form runs on the person's own origin (bridge write window); the chat gets only a reference such as `OV-3F2A1C` |

## The answer rule, in code

`core/policy.mjs` runs only on each owner's server:

- A question names at most 6 exact windows (15–120 minutes, on the quarter hour, within 21 days).
- The answer is one boolean per window. Event titles, reasons, busy blocks and times not asked about
  never leave the server. (`tests/core.test.mjs` checks that no title appears in any answer.)
- Each window answered costs one unit of a **daily disclosure budget**, and a question that would
  exceed it is refused whole, so it cannot be answered in part. Who pays from which budget is decided
  by **signed caller assertions** (`core/grants.mjs`, below): a page that proves who it is gets its
  own 18 a day (the owner can grant it more, or block it), and all verified pages share 60. Everyone
  else (a visitor, or a script that claims an origin) shares 24 a day, at most 12 per network
  address, so it can neither impersonate a page nor use up the budget pages get. However many days
  or pages a prober uses, all untrusted askers together get at most **40 answers about any one
  week** (half of a 9-to-5 week in half hours); pages the owner marks trusted are exempt.
- *Helpful* mode lifts the rule a little: when no asked window is free, the page may add up to two
  nearby free windows, which also cost budget.
- Every question, answered or refused, becomes a receipt in the owner's log.

The owner's own assistant reads the owner's free time with the owner key (`/api/owner/free`).
Nobody else can.

### What a determined prober learns

`eval/adversary.mjs` (real policy code): a prober with K signed pages returns every day and asks
about one target week until refused.

| Setting | Day 1 | Day 2 | Day 3 | Day 7 |
|---|---|---|---|---|
| Free/busy sharing | 100% | 100% | 100% | 100% |
| Overlap without the weekly cap, 1 page | 23% | 23% | 45% | 90% |
| Overlap without the weekly cap, 10 pages | 75% | 100% | 100% | 100% |
| Overlap as shipped, 1 page | 23% | 23% | 45% | 45% |
| Overlap as shipped, 10 pages | 45% | 45% | 45% | 45% |

The weekly cap is a dial, not a finding: with ten fake pages and any number of days, a cap of 12
reveals 15% of a week, 24 reveals 30%, 40 (the default) 45%, 60 reveals 75%. A cooperative
three-person search asks about 6–12 windows per person, so 24–40 leaves room for 2–6 searches a week.

A caller that speaks only the base spec (no signature) still works: it is answered from the shared
unsigned pool.

### Signed caller assertions: knowing which page asks

The browser tells the owner's bridge which *origin* is asking, but a script can call `/api/check`
directly and claim anything. So each page has an Ed25519 key, derived from its owner's secret, with
the public half at `<page>/api/key`.

1. Ana's assistant runs Bo's `overlap_pass` network; the runtime loads Bo's bridge frame (Bo's code,
   on Bo's origin) inside Ana's page.
2. The bridge says hello to its parent by `postMessage`. Ana's page answers only while Ana is
   signed in as owner, and only for pages on her People list, with an assertion from her own
   server: `{iss: Ana's page, aud: Bo's page, exp: +10 min}`, signed.
3. Bo's bridge sends it with the question. Bo's server checks the audience, the expiry, that the
   issuer's origin is the one the browser reported, and the signature against Ana's published key.
4. Bo's receipts then say *signed* next to Ana's page, and Bo can set what that page may ask:
   default, trusted (36 a day) or blocked. Requests signed this way need no email: Bo's answer
   reaches Ana's page.

The assertion travels between the two pages' own code. No agent or model ever sees it.

## Get a page without hosting anything

`hosted/` and `core/hosted.mjs` run many people's pages on one site, at `/u/<id>/`. Anyone opens the
start page, pastes their calendar's private iCal address and their usual hours, and gets a full open
agentic site of their own (manifest, both networks, bridge, signing key, answer rules), already
signed in as owner. The spec allows a site base to be a path, so other pages call
`https://<host>/u/<id>/overlap_pass` like any other.

What the host keeps for each page: the profile, the iCal address (read only by the server, to
answer yes or no; never published), a hash of the owner key, a signing seed, receipts and requests.
The owner can delete the page and all of it. Calendar addresses must be https and may not point at a
private network.

### What it costs in disclosure

`eval/simulate.mjs` runs the real policy code on random three-person scenarios across eight time
zones (no model involved; seeded, reproducible):

| Calendar busy share | Policy | Found a common 30-min window (95% CI) | Questions (rounds) | Half-hour slots of each person's week revealed (of 80) |
|---|---|---|---|---|
| 35–65% (159 scenarios) | Overlap strict | 100% [97.6, 100] | 1.19 | 6.9 |
| | Overlap helpful | 98.7% [95.5, 99.7] | 1.17 | 6.9 |
| | Free/busy sharing | 100% | 1.00 | 80 |
| 60–85% (78 scenarios) | Overlap strict | 98.7% [93.1, 99.8] | 1.27 | 6.9 |
| | Overlap helpful | 96.2% [89.3, 98.7] | 1.21 | 6.9 |
| | Free/busy sharing | 100% | 1.00 | 80 |

Overlap finds the time free/busy sharing finds, in about one round, while revealing under a tenth of
each person's week. Lifting the answer rule (*helpful*) does not help here, unlike in information-
pooling tasks where a requester cannot ask about facts it does not know exist: in scheduling the
space of questions is known in advance (times), so the asker can enumerate it, and the strict rule
costs almost nothing. Its two suggestions occasionally push a search over budget instead.

## Try it locally (three people, three origins)

Requirements: Node 22+.

```bash
node dev/serve.mjs ana 8101   # Ana Lindqvist, Stockholm
node dev/serve.mjs bo 8102    # Bo Okafor, London
node dev/serve.mjs cy 8103    # Cy Tanaka, Toronto
```

1. Open http://localhost:8101/, expand **⚙ AI model settings** and connect a provider (OpenRouter
   sign-in, an Otari key, a Google AI Studio key, or any OpenAI-compatible URL that allows browser calls).
2. Click **Owner** and sign in with the demo owner key `ana-owner-dev` (from `personas/ana.json`).
3. Under **People**, add `http://localhost:8102/` and `http://localhost:8103/`.
4. Ask: *Find 30 minutes next week with Bo and Cy for a pricing sync.* Approve the two cards.
5. Ask: *Send both of them a request for that time.* Fill in each window.
6. Open http://localhost:8102/ as Bo (`bo-owner-dev`) to see what Bo's page was asked, and accept.

The demo calendars (`personas/*.ics`) repeat weekly, so the demo works in any week: the only
30-minute window all three share is Thursday 14:30–15:00 UTC.

## Run your own page

One deployment = one person. Set:

| Variable | Meaning |
|---|---|
| `PASS_PROFILE` | Your profile JSON (see `personas/ana.json`; leave out `dev_owner_key`) |
| `CALENDAR_ICS_URL` | Your calendar's private iCal address (Google Calendar: Settings → *Secret address in iCal format*). Read only by your server. |
| `OWNER_KEY` | A long random string; you type it once in your own browser |
| `BLOB_READ_WRITE_TOKEN` | A private Vercel Blob store, where receipts and requests are kept (set for you by `vercel blob create-store --access private`). Upstash Redis (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`) also works. |

`api/page.mjs` is the Vercel function (vercel.json rewrites `/api/*` to it); any Node host works with `core/api.mjs`.

For the hosted site instead: `node dev/prepare-hosted.mjs && cp vercel.hosted.json vercel.json &&
vercel deploy --prod` (`api/hosted.mjs`; needs a private Vercel Blob store, or Upstash Redis), or
run `node dev/serve-hosted.mjs 8200` locally.

## Tests

```bash
node --test tests/core.test.mjs              # policy, budgets, time zones, signatures, hosted pages, server routes
node dev/build.mjs --check                   # official agentify-website build checks on both networks
node dev/script-router.mjs 8198 &            # a scripted "model": no model calls, deterministic
node tests/e2e/run.mjs --scripted            # real headless Chrome, three origins
node tests/e2e/run.mjs --scripted --hosted   # the same, as three hosted pages on one site
node tests/e2e/run.mjs                       # with a real model behind an OpenAI-compatible router
```

The end-to-end test signs in as Ana, adds Bo and Cy, asks for a time, approves each consent card,
sends the requests, fills in each person's window on that person's page, has Bo accept, and then
checks on Bo's and Cy's servers (16 checks): each was asked at most 6 windows; every receipt names
Ana's page and is **signed** by it; the pending request is for a window all three are free and
knows Ana's page; Bo's acceptance yields an `.ics` invite for that window; and no event title of
Bo's or Cy's reached Ana's chat. With `--scripted` the whole run takes about 20 seconds and costs
nothing, so it can run on every change; we also ran it with Gemini behind a local router.

`dev/script-router.mjs` is useful beyond Overlap: any open agentic site can test its partner calls,
bridges and write windows against it without a model or a key.

## Limits, said plainly

- Unsigned askers (visitors, scripts) share 24 answers a day; a script rotating network addresses is
  held by that total, and cannot touch the budget signed pages get. Behind a shared office network,
  unsigned colleagues share the per-address limit; signed pages do not.
- On the hosted site, pages share one origin, and the reference runtime does not show consent cards
  between pages of the same site. Assertions, budgets and receipts work the same; for consent cards
  between people, give each page its own origin (self-hosted, or one subdomain per page).
- A yes/no answer still leaks one bit per window. The budget limits how many bits per day.
- Usual working hours are published (owner's choice, `publish_hours`), so assistants do not waste
  budget on 3 a.m. questions.
- The agent networks run in the caller's tab: no background negotiation, no reminders.
- Accepting a request blocks that time on the page and issues a standard .ics invite
  (`/api/invite.ics?ref=…`); the owner's accepted meetings are also a private subscription feed
  (`/api/calendar.ics?token=…`, shown on the owner's panel). Overlap never writes to the calendar itself.

## Credits

The browser runtime in `site/runtime/` and the build tool in `tools/agentify-website/` are from
[cognizant-ai-labs/agentic-web](https://github.com/cognizant-ai-labs/agentic-web) (Apache-2.0),
itself based on [nsDeploy](https://github.com/cognizant-ai-lab/nsdeploy). They are unmodified.
Everything else in this repository was written for this project.
