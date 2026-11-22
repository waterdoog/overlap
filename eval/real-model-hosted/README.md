# Real-model runs, hosted pages (Gemini, 2026-11-22)

`node tests/e2e/run.mjs --hosted --router http://127.0.0.1:8199/v1 --model gemini-4-neon`: Ana, Bo
and Cy as hosted pages on one site (`/u/<id>/`), a consent card before each other hosted page, the
real model through a local router. 20 runs in a row; per-run output in `runN/`.

Result: **19 of 20 runs passed all 18 checks.** Median about 2.3 minutes per run.

Run 12 failed one check: the model provider returned HTTP 502 while the assistant was asking Bo's
page. The assistant reported that Bo's page did not answer and sent no request; nothing wrong was
sent or shown. No run hit the runtime's 90-second limit per message.

Runs 16-20 ran after the visual redesign of the pages (same element ids), so they also check that
the redesign did not break the flow.
