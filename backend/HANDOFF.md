# Backend handoff — Aarya → integration

## What's in this branch

This branch is `frontend` plus my prompt work. Blair's backend (endpoints, exact-substring filter, CORS, tests, mock mode, `render.yaml`, `llm.py`) is unchanged. I only touched the prompts and the test data.

| File | What changed |
|---|---|
| `prompts.py` | Tuned `ANALYZE_PROMPT` and `SIMPLIFY_PROMPT`. Drop-in: same `{paragraphs}` / `{sentence}` placeholders, same JSON shapes, same `format_paragraphs()`. |
| `test_paragraphs.txt` | 21 real paragraphs from a journal paper, replacing the 3 made-up examples, for `prompt_lab.py`. |
| `gold.json`, `gold_simplify.json` | Answer keys for those paragraphs (see Test data). |
| `../.gitignore` | New. Keeps `.env`, `.venv/`, `__pycache__/` and `.pytest_cache/` out of git. The repo had none. |

`llm.py` already does everything my standalone Gemini call did (async client, temperature 0.2, JSON mode, one retry, mock mode), so I did not change it.

## What the prompts now ask for

- Whole sentences copied character for character, including citation numbers and typos.
- About 1 highlight per paragraph that has a claim, finding, setup or caveat; at most 2; none for methods, ethics or statistics-software paragraphs. About 15–20% of sentences overall.
- `main` 1–3 times per article, at least once. Every setup paragraph gets a `background`. `counter` is hunted actively ("however", "although", "limitations", "small sample"…).
- `/simplify`: 2–4 exact pieces in reading order, keeping words that change the meaning ("was significantly higher", "might", "not", "for control children").
- Article text sits between delimiters and is treated as data, not instructions.
- Each prompt ends with an explicit JSON example, because `ask_json` passes no response schema. Keep those lines.

## Status: not yet scored against gold

The free-tier quota ran out before the latest prompts could be evaluated. The last measured run used an earlier, stingier version:
- `/analyze`: 86% of returned sentences were exact (target ≥ 90%), but only 5% of sentences were highlighted (target 10–20%). Too few `main` and no `background`. `counter` detection was good.
- `/simplify`: every successful call was exact and in order, but the pieces were too terse. Median 4.4 s per call (target ~2 s).

Scoring is now one command each (tested in mock mode only, so far):
`python prompt_lab.py --score` (1 Gemini call, vs `gold.json`) and
`python prompt_lab.py --score-simplify --limit 5` (5 calls, vs `gold_simplify.json`).

## Model, key and quota

- `GEMINI_MODEL=gemini-3.6-flash` (the repo default). On our key, `gemini-2.5-flash` returns 404 ("no longer available to new users"), and `gemini-3.8-flash` times out.
- **Free tier: 20 generate requests per day per model.** `gemini-3.5-flash` counts against the same quota as 3.6-flash, so switching between them doesn't help. Every article and every sentence click is a call, so the demo will likely need billing turned on or a second key.
- `GEMINI_API_KEY` is **not** in this repo and never will be. Ask me for it directly, or make your own at aistudio.google.com/apikey. Heads up: a UMass Google account cannot create the Cloud project you need, so use a personal Gmail.
- Temperature 0.2. Higher values make the model paraphrase, and paraphrased sentences get dropped.

## Test data

| File | What it is |
|---|---|
| `test_paragraphs.txt` | 21 real paragraphs from one journal paper, plain text, blank-line separated |
| `gold.json` | The same paragraphs with hand-marked highlights and roles — the answer key |
| `gold_simplify.json` | 22 sentences with hand-marked backbones, for `/simplify` |

All hand-checked: every sentence and every core phrase is an exact substring of its source. About 20% of sentences are highlighted.

Known gap: the samples all come from one science paper, and `main` is over-used in them (11 of 22). Blair's spec wants 1–3 `main` per article, so don't treat the `main` labels in `gold.json` as gospel.

## The one rule

Every `text` must appear character for character in its paragraph, and every `core` piece in its sentence. The extension finds sentences by exact text match and forgives only extra whitespace. A paraphrased sentence doesn't error — it silently never appears. Keep the repo's filter in `main.py` and never return anything that hasn't been through it.

## Caching

Blair's spec asks for an in-memory dict. Use that. I have a working MongoDB Atlas cache from my own prototype if we go for the sponsor prize; ask me before spending time on it.

## Done during integration

- In-memory LRU cache (256 entries) for `/analyze` and `/simplify` (`cache.py`): the same article or sentence costs no second Gemini call. `/analyze` caches per chunk. The key ignores whitespace, and a hit is mapped back onto the new request's exact spacing. Empty answers are never cached, so a bad reply gets asked again. Hits show in the server log only.
- Two identical requests at the same time (double click) share one Gemini call (`main.ask_once`).
- One retry with a 1.5 s pause on timeouts and 5xx (`llm.ask_json`). No retry on 429, a bad key or a missing model. A 429 whose text names the per-day quota (`...PerDay...`) says "daily limit is used up"; any other 429 says "wait a minute".
- Chunking on size, because the reply gets cut off by length, not paragraph count: an article becomes several calls only above 20,000 characters or 80 paragraphs (`CHUNK_CHARS`, `CHUNK_MAX_PARAGRAPHS`). Chunks are balanced by characters (not paragraph count, which let one chunk of a mixed short/long article reach 35,000 characters) and no chunk goes over `CHUNK_MAX_CHARS` (24,000) unless a single paragraph is longer. 2 run at a time, and the first 429 stops the rest; if every chunk fails, a 429 is reported ahead of other errors so the reader sees "daily limit", not "try again". **Cost per article:** anything the extension sends under 20,000 characters is 1 call; the largest allowed article (60,000 characters / 200 paragraphs) is usually 3 calls, up to 5 in the worst case (several ~21,000-character paragraphs between short ones).
- Partial results: if some chunks fail, `/analyze` still returns the others with HTTP 200 and logs `N of M chunks failed`. The reader isn't told (the contract has no field for it). Pressing Analyze again pays only for the failed chunks, because the good ones are cached.
- Limits: empty list or only blank paragraphs → 400 (no call), over 60,000 characters → 413, over 200 paragraphs → 413. Blank paragraphs are dropped before the call.
- Stricter filter (`filters.py`, ported from `standalone/validator.py`): no empty, duplicate or overlapping highlights, at most 2 per paragraph, article order. `/simplify` pieces must be exact, in order and not overlap.
- Human error messages (quota → 503, bad key / bad model / anything else → 502); the real exception goes to the server log only. The extension now shows the `detail` text.
- `prompt_lab.py --score` and `--score-simplify` (see Status). `--score` precision/recall are strict (exact sentence after whitespace); "gold touched" is a lenient overlap count. Mock-mode numbers mean nothing about prompt quality.
- `gold_simplify.json` rows 8 and 9 list their pieces out of sentence order. Not edited (it's hand-made data); `--score-simplify` now scores gold pieces in any order and prints a note.

- `main` is capped at 3 per article after merging chunks (`cap_main` in main.py); the first 3 in article order are kept.

## Not done

- Scoring the current prompts against `gold.json` with the real model (blocked on quota; the commands are ready).
- `/simplify` speed (~4 s; the target is ~2 s).
- Deploy to Render.
- The security gate items in `CLAUDE.md`, which should be finished before the demo.

## Questions

Ask me. I know where the bodies are buried in the prompt.
