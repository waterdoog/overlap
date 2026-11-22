# Real-model end-to-end runs (Gemini, 2026-11-22)

`node tests/e2e/run.mjs` with `gemini-4-neon` behind `dev/llm-proxy.mjs` (an OpenAI-compatible
router on this machine; the browser never saw the key). Each run: three fresh pages on three
origins, "Find 30 minutes next week with Bo and Cy for a pricing sync.", approve two consent cards,
"Send both of them a request for the time that works for everyone, titled Pricing sync.", fill both
partner windows, Bo accepts; then 18 checks on the partners' servers and the chat transcript.

| Run | Checks passed | Model calls | Wall time |
|---|---|---|---|
| 1 | 18/18 | 15 | 168 s |
| 2 | 18/18 | 15 | 202 s |
| 3 | 18/18 | 15 | 144 s |
| 4 | 18/18 | 15 | 353 s |
| 5 | 6/11 run, then stopped | 20 | 101 s |
| 5 (rerun) | 18/18 | 15 | 225 s |
| 6 | 18/18 | 15 | 140 s |

Run 5 failed outside Overlap: the development proxy crashed on an upstream timeout, and the page
reported "couldn't connect to the AI router" without sending anything. The proxy now answers 502
on upstream errors. Every completed run found the only common window (Thursday 14:30 UTC), asked
each person exactly 6 windows, and leaked no event title. 6 of 7 runs passed; all 6 runs with a
working router passed. Wall time is dominated by the model (a thinking model, several seconds per
call); the pages' own servers answer in milliseconds.
