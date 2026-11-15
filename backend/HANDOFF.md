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

The current prompts target those gaps. Run `python prompt_lab.py` against `test_paragraphs.txt` and compare with `gold.json` before the demo.

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

## Not done

- Scoring the current prompts against `gold.json` (blocked on quota).
- `/simplify` speed (~4 s; the target is ~2 s).
- Chunking long articles (Blair: ~20 paragraphs per call, parallel with `asyncio.gather`, merge keeping ids). Needed for 60+ paragraph pages or the JSON truncates.
- Deploy to Render.
- The security gate items in `CLAUDE.md`, which should be finished before the demo.

## Questions

Ask me. I know where the bodies are buried in the prompt.
