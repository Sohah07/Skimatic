# Skimatic
Chrome extension that highlights the key points of any article, color-coded by role
(main point, evidence, background, other side). Click a highlighted sentence to bold
its backbone (who did what to what) and fade the extra details. Built at HackUMass 2026.

```
extension/  Chrome extension (Manifest V3): content script, side panel, background worker
backend/    FastAPI server that asks Gemini to pick + label key sentences
testing/    Local test article + manual test plan
docs/       API contract (read this first!), roadmap, prompt notes
```

**How it fits together:** side panel button → `background.js` asks the page's
`content.js` to extract the article (Readability.js) → `background.js` POSTs the
paragraphs to the backend `/analyze` → Gemini picks sentences → `content.js`
paints them with `highlight.js`. Clicking a highlight calls `/simplify`.

The request/response shapes are in [docs/API_CONTRACT.md](docs/API_CONTRACT.md).
The plan and who-does-what is in [docs/ROADMAP.md](docs/ROADMAP.md).

## Features

- **Highlights by role**: main point, evidence, background, other side. Each role has its own color (you pick them) *and* its own underline style (solid, dotted, dashed, wavy), so color isn't the only cue.
- **Sentence backbone**: click a highlight, or Tab to it and press Enter. The subject, verb and object turn bold and the extra details fade.
- **Key points list** (side panel): every highlight in article order. Click one to jump to it on the page. It has filters per role, a ✓ for points you've seen, and a "you are here" marker.
- **Reading comfort** (side panel), opt-in and adjustable:
  - Presets: Off · Easy reading · Focus.
  - Text: font (Atkinson Hyperlegible, Lexend or Verdana; bundled, no network), size, letter spacing, word spacing, line height, line width.
  - Themes: cream, grey-blue or dark, all at 7:1 contrast or better.
  - Clean reading view without ads or menus (Alt+Shift+R).
  - Focus mode dims the other paragraphs; move with the mouse or J / K (Alt+Shift+F).
  - Highlight density: all 4 roles, main + evidence, or main only.
- **Listen**: reads the highlighted sentences, or the whole article, aloud one sentence at a time, with speed and voice controls.
- **Progress**: "4 of 12 key points seen · about 6 min left".

Why each feature exists, and what we deliberately left out (e.g. "dyslexia fonts", Bionic Reading), is in [docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md).

**UI preview without the extension:** open `extension/sidepanel/sidepanel.html` straight in Chrome (File → Open File). Every button works with fake data. Add `?state=offline` or `?state=error` to the URL to see those states.

## Run the backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # then paste your GEMINI_API_KEY into .env
uvicorn main:app --reload --port 8000
```

Open http://localhost:8000/health → `{"status":"ok","mock":false}`.
No key yet? Leave it empty: the server runs in **mock mode** and returns fake (but
correctly shaped) highlights, so the extension can be built without the AI.
Interactive API docs: http://localhost:8000/docs. Tests: `pytest`.

Try prompts without the extension: `python prompt_lab.py` (uses `test_paragraphs.txt`).

## Integration

The `integration` branch starts from the team's `backend` branch, which already
contains the `frontend` work (the extension), Blair's FastAPI server and Aarya's
tuned prompts and gold answer keys. On top of that it hardens the backend for the demo: cache, one retry, chunking for long articles,
request limits, a stricter filter and human error messages. The API contract did
not change. Status and open items: [backend/HANDOFF.md](backend/HANDOFF.md).

- Run: see "Run the backend" above. Without a key it runs in mock mode.
- Tests: `cd backend && python -m pytest -q` (no key needed).
- Score the prompts: `python prompt_lab.py --score` (1 Gemini call) and
  `python prompt_lab.py --score-simplify` (5 calls). Add `MOCK_LLM=1` to try them for free.
- `backend/standalone/` is Aarya's earlier prototype with a **different** API. It is
  kept for reference only; the extension does not use it.

## Load the extension

1. Chrome → `chrome://extensions` → turn on **Developer mode** (top right).
2. **Load unpacked** → pick the `extension/` folder.
3. Pin it, open any article, click the icon → the side panel opens.
4. Click **Highlight this article**.

After editing extension code, hit the ↻ reload button on `chrome://extensions`
and refresh the article tab. The backend URL lives at the top of `extension/background.js`.

Local test page: `cd testing && python3 -m http.server 5500`, then open
http://localhost:5500/article.html.
