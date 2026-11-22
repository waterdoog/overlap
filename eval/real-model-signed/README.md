# Real-model runs with signed caller assertions (Gemini, 2026-11-22)

Live: `node tests/e2e/run.mjs --live --router https://overlap-ana.vercel.app/llm/v1` (three public
pages, signed assertions verified over the internet, the demo pages' own free model).

| Run | Checks | Notes |
|---|---|---|
| live 1 | 18/18 | |
| live 2 | 18/18 | |
| live 3 | 9 of 11 run | the model was slow and the reference runtime's fixed 90-second limit per message skipped both partner answers; in the next turn the assistant re-checked instead of sending requests, so nothing wrong was sent |
| live 4 | 18/18 | |
| live 5 | 18/18 | |

Every receipt in every live run was signed by Ana's page and verified by Bo's and Cy's servers.

Hosted (local, first attempt): run 1 answered correctly but its six candidate windows did not include
the common one, because the test's hosted Ana lacked the persona's Friday focus time (fixed in the
test); runs 2-3 were lost to the test harness (headless Chrome dropped, then its leftover process held
the DevTools port). The hosted batch is in `../real-model-hosted/`.
