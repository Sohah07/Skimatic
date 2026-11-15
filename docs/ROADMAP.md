# Roadmap: order of steps

The starter code already does the whole flow end to end with **fake AI results**
(mock mode). So nobody waits on anybody: each person replaces one piece of the
skeleton with the real thing, and the pieces fit because they all follow
[API_CONTRACT.md](API_CONTRACT.md).

```
 Side panel ──► background.js ──► content.js (Readability: get paragraphs)
 (UI)            (Extension)        │
                    │               ▼
                    └──► backend /analyze ──► Gemini        (Backend)
                    ◄── highlights ◄──┘
                    └──► content.js highlight.js paints colors
```

## Step 0 — Everyone, together (~30 min, first meeting)

1. Send GitHub usernames, get added as collaborators, `git clone` the repo.
2. Each person runs the backend in mock mode and loads the extension (see README).
3. Open `testing/article.html` and click **Highlight this article**. You should see 4
   colored sentences, and clicking one bolds a few words. **If this works on all
   4 laptops, setup is done.**
4. Read `docs/API_CONTRACT.md` together. This is the only thing you can't change
   without telling everyone.
5. Git rule: each person works on their own branch (`backend/...`, `ext/...`,
   `ui/...`) and merges small PRs often. Never commit `.env`.

## Step 1 — Work in parallel (the PDF to-do list)

### Backend — `backend/`
| Order | Task | Where |
|---|---|---|
| 1 | Get a Gemini key (aistudio.google.com/apikey), put it in `backend/.env`. Restart server; `/health` should say `"mock": false`. | `.env` |
| 2 | Replace the 3 sample paragraphs with 10–15 real ones (news, opinion, science). | `test_paragraphs.txt` |
| 3 | Run `python prompt_lab.py`, tweak the prompt, re-run. Goal: almost all `OK`, sensible roles. Log each try. | `prompts.py`, `docs/PROMPT_NOTES.md` |
| 4 | Same for `--simplify "some long sentence"`. | `prompts.py` |
| 5 | Deploy to Render (`render.yaml` is ready: New → Blueprint) and set `GEMINI_API_KEY` there. Send the URL to the extension person. | `render.yaml` |
| 6 | Later: long articles. Split into batches of ~20 paragraphs and run them in parallel if one call is slow or truncated. | `llm.py` |

Already done for you: FastAPI app, `/health`, CORS, `/analyze`, `/simplify`, filtering
out any sentence the AI didn't copy exactly, mock mode, tests (`pytest`).

### Chrome extension — `extension/`
| Order | Task | Where |
|---|---|---|
| 1 | Read the 4 files top to bottom; they're commented. Use the **Debug → Ping page** button to see side panel → page messaging. | all |
| 2 | Test Readability on ~10 real sites, fill section A of `testing/TEST_PLAN.md` together with the testing person. Fix extraction rules if needed. | `content.js` `extractArticle()` |
| 3 | Improve matching where highlights aren't found (curly vs straight quotes, footnote markers like `[1]`). | `highlight.js` `normalize()` |
| 4 | Cache results per URL (`chrome.storage.session`) so re-opening a page doesn't call the AI again. | `background.js` |
| 5 | When backend is deployed: change `BACKEND_URL` at the top of `background.js`. | `background.js` |
| 6 | Stretch: show a small loading indicator on the page while analyzing; highlight paragraphs progressively as batches come back. | `content.js` |

Already done for you: Manifest V3, content script + side panel + service worker
messaging, Readability.js, `highlight(text, color)` (handles sentences that span
links/italics, no layout change), click-to-simplify, re-injection into old tabs.

### UI / frontend — `extension/sidepanel/` + `extension/content.css`
| Order | Task | Where |
|---|---|---|
| 1 | Moodboard, 8–10 candidate colors (check light + dark sites and a colorblind simulator), wireframes, icon drafts. *(design work, no code)* | Figma etc. |
| 2 | Put the 4 chosen default colors + labels in one place. | `shared/roles.js` |
| 3 | Restyle the side panel to match the wireframes. Keep the element `id`s or update `sidepanel.js`. | `sidepanel.html/.css` |
| 4 | Tune how highlights look on the page (opacity in `color-mix(... 45%)`, underline vs fill, the bold/fade look). | `content.css` |
| 5 | Export icons as 16/32/48/128 px PNGs into `extension/icons/` and add an `"icons"` entry to `manifest.json`. | `manifest.json` |
| 6 | Final wording for buttons, legend and empty/error states. | `sidepanel.*` |

Tip: preview the side panel without the extension: open `extension/sidepanel/sidepanel.html`
in Chrome (File → Open File) and refresh after each edit. Add `?state=offline` or `?state=error`
to the URL to see those states. Inside the real extension: right-click the panel → Inspect.

### Integration & testing — `testing/` (+ glue between everyone)
| Order | Task | Where |
|---|---|---|
| 1 | Own Step 0: make sure all 4 laptops run the mock flow. | README |
| 2 | Pick 5–10 real articles, run the test plan (section A), report bugs to the right person as GitHub issues. | `TEST_PLAN.md` |
| 3 | As soon as the backend has a real key: run the flow with real AI on the same articles. Compare "found x/y". | |
| 4 | When backend is deployed: switch `BACKEND_URL`, test from a laptop that isn't running the server. | `background.js` |
| 5 | Run checklist B before every merge to `main` from now on. | `TEST_PLAN.md` |
| 6 | Pick demo articles + a backup, write the demo script (30-sec pitch → highlight → change a color → click a sentence). | `TEST_PLAN.md` C |

## Step 2 — First real integration (checkpoint)
Goal: **real AI highlights on a real article, from the deployed backend.**
Needs: Backend step 5, Extension step 5. Do it as soon as both are ready, even if
prompts and UI are rough. Most hackathon bugs show up here, so find them early.

## Step 3 — Improve in loops
Backend makes prompts better → testing person re-runs the test plan → extension
fixes sentences that aren't found → UI polishes. Merge small, test after each merge.

## Step 4 — Feature freeze & demo (last ~3 hours)
No new features. Only fixes from checklist B. Record a backup demo video in case
the live demo or Wi-Fi fails. Write the Devpost description (use the PDF's description).
