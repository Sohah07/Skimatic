# Semblock backend: learning log

## File map
- `NOTES.md`: this learning log.
- `.gitignore`: list of files git must never track (`.env`, `.venv/`, caches).
- `backend/db.py`: MongoDB cache: `article_hash`, `get_cached`, `save`, plus the 7-day TTL index. Any DB problem means "no cache" (with a 60s cooldown), never an error.
- `backend/main.py`: the FastAPI app. Loads `.env` at startup and defines the endpoints: `GET /ping` and `POST /analyze` (checks limits, checks the MongoDB cache, else calls Gemini and validates and saves; every error is `{"error": ...}`).
- `backend/models.py`: Pydantic models for the request, a highlight, the response, and the error body (the contract as code), plus `GeminiHighlight`/`GeminiResult` (what we ask Gemini for, no `id`).
- `backend/gemini_client.py`: `ask_json(prompt, schema)` (one Gemini call, temperature 0.2, one retry), plus `analyze(paragraphs)` and `simplify(sentence)` in the team's contract shapes. Self-contained so it can move into Blair's `llm.py`.
- `backend/prompts.py`: `ANALYZE_PROMPT` (roles main/evidence/background/counter, paragraphs labelled by request id) and `SIMPLIFY_PROMPT` (2-4 exact pieces in order). Edit here to tune.
- `backend/test_paragraphs.txt`: 21 test paragraphs (Tatsumi et al. 2015), separated by blank lines.
- `backend/gold.json`: hand-picked "right answer" highlights for those 21 paragraphs (22 highlights).
- `backend/gold_simplify.json`: 22 sentences with their hand-picked `core` pieces.
- `backend/validator.py`: pure functions: `check_request` (empty / too many / too long) and `validate` (verbatim checks, per-paragraph cap, reading-order ids and outline).
- `backend/prompts_for_repo.py`: drop-in replacement for Blair's `backend/prompts.py`: our tuned prompts with `{paragraphs}`/`{sentence}` placeholders, doubled JSON braces, and his `format_paragraphs()`.
- `backend/requirements.txt`: the packages the backend needs, each pinned to an exact version (now includes `pymongo` and `certifi`).
- `backend/.venv/`: the virtual environment (installed packages). Not committed; rebuild with `pip install -r requirements.txt`.
- `backend/samples/request.json`: an example `/analyze` request (3 paragraphs about an invented city) for testing and for teammates.
- `backend/samples/response.json`: the mock `/analyze` response, captured from the live server. Send this to teammates to build against.
- `backend/scripts/try_gemini.py`: standalone script that makes one Gemini call on `samples/request.json` and prints the reply.
- `backend/tests/test_validator.py`: pytest tests for the validator (verbatim, paraphrase, core, cap, empty request, reading order).
- `backend/.env`: secrets (Gemini key, model name, MongoDB URI). Never shared, never committed.

## Glossary
- **git**: a tool that records snapshots ("commits") of your project's files over time.
- **`.gitignore`**: a text file of patterns; git refuses to track any file that matches.
- **environment variable**: a named setting (like `GEMINI_API_KEY`) that a program reads from its surroundings instead of having it written in the code.
- **`.env` file**: a file holding environment variables as `NAME=value` lines, loaded at startup so secrets stay out of the code.
- **virtual environment (`.venv`)**: a private folder of Python packages for one project, so its versions don't clash with other projects.
- **`__pycache__`**: a folder where Python saves pre-compiled copies of your files to start faster. Auto-generated, so never committed.
- **package**: reusable code someone else wrote, installed with `pip` (e.g. FastAPI).
- **pip**: Python's package installer.
- **pinning**: writing an exact version (`fastapi==0.163.0`) so every machine installs the same code.
- **dependency**: a package your code needs in order to run.
- **FastAPI**: the web framework we use to define our backend's URLs and what they return.
- **uvicorn**: the server program that runs a FastAPI app and listens for requests.
- **Pydantic**: a library that checks data has the right shape and types.
- **python-dotenv**: reads a `.env` file and turns its lines into environment variables.
- **endpoint**: a URL path + HTTP method that the server answers, e.g. `GET /ping`.
- **HTTP method**: the kind of request. `GET` = fetch something; `POST` = send data to be processed.
- **request / response**: the message a client sends to the server, and the message the server sends back.
- **JSON**: a text format for data (`{"key": "value"}`) that both Python and JavaScript read easily.
- **status code**: a 3-digit number on every response saying how it went. 200 = OK, 404 = no such endpoint, 4xx = client's fault, 5xx = server's fault.
- **decorator (`@app.get(...)`)**: a line above a function that registers it with FastAPI as the handler for a URL.
- **localhost / `127.0.0.1`**: "this same computer". A server bound to it can only be reached from your own laptop.
- **port**: a numbered door on a computer that a server listens on (we use 8000).
- **curl**: a terminal command that sends an HTTP request and prints the response.
- **`load_dotenv()`**: python-dotenv's function that reads `.env` and adds each `NAME=value` to the environment variables.
- **`os.getenv("NAME")`**: reads one environment variable; returns `None` if it isn't set.
- **process**: one running program (e.g. the uvicorn server). Environment variables belong to a process and vanish when it stops.
- **`__file__`**: a built-in variable holding the path of the current Python file.
- **request body**: the data a client sends along with a POST request (here, JSON with `url` and `paragraphs`).
- **API contract**: the agreed shape of requests and responses, so frontend and backend can be built separately.
- **ASCII**: the basic set of plain English characters. Curly quotes and long dashes are not ASCII and often break exact text matching.
- **mock**: a fake, hardcoded version of something real, used so others can build against it before the real thing exists.
- **model (Pydantic)**: a class that describes a data shape; creating one checks the data and raises an error if it doesn't fit.
- **`BaseModel`**: the Pydantic class every model inherits from; it provides the checking.
- **type hint**: the `: str` / `: list[str]` after a field name, saying what type the value must be.
- **`Literal[...]`**: a type that allows only the exact listed values.
- **`Field(...)`**: adds extra rules to a field, e.g. `ge=0` (greater than or equal to 0), `min_length` / `max_length` for lists.
- **`str | None = None`**: "a string or nothing", defaulting to nothing; this makes the field optional.
- **`ValidationError`**: the error Pydantic raises when data doesn't match a model.
- **`response_model`**: tells FastAPI which model the endpoint returns, so the output is checked and documented.
- **`Content-Type: application/json`**: a request header telling the server the body is JSON.
- **422 Unprocessable Content**: FastAPI's default status when the request body doesn't match the request model (we'll replace its body with our `{"error": ...}` shape in milestone 4).
- **constant**: a variable that never changes after it's set; by convention written in ALL_CAPS (e.g. `MOCK_RESPONSE`).
- **pipe (`|`)**: sends one command's output into the next command as input.
- **redirect (`>`)**: writes a command's output into a file (overwriting it).
- **SDK (Software Development Kit)**: a library a company provides so your code can call its service; `google-genai` is Google's for Gemini.
- **client**: the object in your code that talks to an outside service (here `genai.Client`).
- **structured output**: asking the AI to reply in JSON that follows a schema you give it, instead of free text.
- **JSON Schema**: a standard JSON description of what valid data looks like; Pydantic makes one with `Model.model_json_schema()`.
- **transitive dependency**: a package you don't use directly but one of your packages needs (google-genai -> google-auth -> cryptography).
- **wheel**: a prebuilt, ready-to-install package file. Without one for your machine, pip tries to compile from source, which can fail.
- **timeout**: the longest we'll wait for a reply before giving up.
- **token**: a chunk of text (~3/4 of a word) that AI models read, write, and bill by.
- **stack trace**: the long error printout listing every function that was running when a crash happened. Fine in scripts; never sent to users.
- **404 Not Found**: the thing you asked for doesn't exist (here: a model retired for new users).
- **503 Service Unavailable**: the server is temporarily overloaded; try later or elsewhere.
- **504 Gateway Timeout / DEADLINE_EXCEEDED**: the server accepted the request but didn't finish in time.
- **prompt**: the instruction text we send to the AI model.
- **delimiters**: markers (like `<<<ARTICLE ... ARTICLE>>>`) that fence off untrusted text so the model treats it as data.
- **template**: fixed text with a `{placeholder}` that gets filled in later with `.format(placeholder=value)`.
- **`sys.path`**: the list of folders Python searches when you `import` something.
- **non-deterministic**: gives different outputs for the same input; AI models are, so the same article can get different highlights each run.
- **function**: a named, reusable block of code that takes inputs (parameters) and gives back a result (`return`).
- **exception**: Python's way of signalling an error; it stops normal flow until something `except`s (catches) it.
- **custom exception**: our own error class (`class GeminiError(Exception)`) so callers can catch one kind of failure.
- **`raise ... from e`**: raise a new error while keeping the original one attached as `__cause__`, for debugging.
- **return type hint (`-> GeminiResult`)**: says what kind of value the function gives back.
- **502 Bad Gateway**: "a server I depend on failed"; we return it when Gemini fails.
- **`JSONResponse`**: FastAPI's way to send JSON with a status code you choose (e.g. 502).
- **logging / logger**: writing messages to the server's output for the developer to read; users never see them.
- **list comprehension**: a one-line way to build a list: `[f(x) for x in items if cond]`.
- **`**h.model_dump()`**: unpacks a model's fields as keyword arguments, so one model can be copied into another with extra fields added.
- **pure function**: output depends only on its inputs; no network, database, files, or hidden state. Easy to test.
- **substring**: a piece of text found exactly inside a longer text (`"cat" in "concatenate"` is True).
- **`str.find(x)`**: position where `x` first appears in a string, or `-1` if it doesn't.
- **400 Bad Request**: the client sent something invalid (here: no paragraphs).
- **413 Content Too Large**: the request is bigger than the server accepts (here: >80 paragraphs or >20,000 characters).
- **`NamedTuple`**: a small fixed bundle of named values, e.g. `result.highlights`, `result.capped`.
- **`set`**: an unordered collection with no duplicates; fast to check "have I seen this?".
- **sort key**: the value Python sorts by; `(paragraph, position)` sorts by paragraph first, then position.
- **test**: a small function that runs code on a known input and checks the output.
- **pytest**: the tool that finds functions named `test_*`, runs them, and reports pass/fail.
- **`assert`**: "this must be true"; if it isn't, the test fails and pytest shows both values.
- **`@pytest.mark.parametrize`**: runs one test several times with different inputs.
- **helper function**: a small function that saves repetition (here `hl(...)` builds fake highlights).
- **exception handler**: a function FastAPI calls whenever a certain kind of error happens, so we choose the response.
- **405 Method Not Allowed**: the URL exists but not for that method (e.g. GET on a POST-only endpoint).
- **500 Internal Server Error**: an unexpected bug on our side; we return a plain message and log the details.
- **log level**: how important a log message is (DEBUG < INFO < WARNING < ERROR); a logger only prints messages at or above its level.
- **MongoDB Atlas**: MongoDB's cloud service; our database runs on their servers.
- **cluster**: the database server(s) Atlas runs for us (we use the free tier).
- **database user**: the username/password our code logs in with; ours (`skimatic_app`) can only read/write the `skimatic` database.
- **IP allowlist (Network Access)**: the internet addresses Atlas accepts connections from; changes when you change wifi.
- **connection string (`MONGODB_URI`)**: one line with the cluster address and login; contains the password, so it's a secret.
- **driver (PyMongo)**: the library that lets Python talk to MongoDB.
- **`timeoutMS` (CSOT)**: PyMongo's single time limit covering every step of a database operation; we use 2000 ms.
- **ping**: a tiny "are you there?" command to check a connection works.
- **TLS**: the encryption behind https and the browser padlock; also protects our MongoDB connection.
- **certificate / root certificates**: a server's signed ID card, and the list of trusted signers your computer checks it against.
- **`certifi`**: a package containing the standard list of trusted root certificates.
- **SHA-256 hash**: a fixed 64-character fingerprint of some data; same input always gives the same hash, and you can't get the text back from it.
- **cache hit / miss**: the answer was already stored (hit) or wasn't (miss).
- **TTL index**: a MongoDB index that auto-deletes documents a set time after a date field (ours: 7 days after `created_at`).
- **upsert**: update the document if it exists, insert it if it doesn't.
- **cooldown**: after a failure, skip the database for a while so every request isn't slowed by retrying.
- **database**: a named container on the cluster (ours: `skimatic`).
- **collection**: a group of similar documents inside a database, like a table (ours: `analyses`).
- **document**: one record in a collection, stored like a JSON object, with a unique `_id` (ours: the article's hash).
- **`time.perf_counter()`**: a precise stopwatch clock for measuring how long something took.
- **gold set**: hand-made correct answers used to score what the model returns.
- **temperature**: how random a model's output is; low (0.2) means more literal, more exact copying.
- **retry**: trying a failed call once more after a short pause; never in a tight loop, because of rate limits.
- **rate limit**: a cap on how many calls you may make per minute or day (the Gemini free tier has one).
- **precision / recall**: of what the model picked, how much matched gold (precision); of gold, how much the model found (recall).
- **429 Too Many Requests**: you hit a rate limit; wait before calling again.
- **clone**: download a full copy of a GitHub repo, with its history, onto your laptop.
- **push**: send your local commits to GitHub so others can see them.
- **pull request (PR)**: a GitHub page asking the team to review and merge one branch into another.
- **escaped braces (`{{ }}`)**: in a `.format()` template, `{{` and `}}` print as literal `{` and `}`; single braces mark placeholders.

## Log

### Milestone 1, Step 1: `.gitignore`
We created `.gitignore` at the project root so git will never track `.env` (secrets), `.venv/` (installed packages), or auto-generated cache files. We did this first because once a secret is committed it stays in git history even after deletion.

Commands:
- `cat .gitignore`: prints the file's contents to the terminal.

### Milestone 1, Step 2: `requirements.txt` and the virtual environment
We created a virtual environment in `backend/.venv` so this project's packages stay separate from the rest of the computer. We listed FastAPI, uvicorn, Pydantic and python-dotenv in `requirements.txt` with exact versions and installed them.

Commands (run from `backend/`):
- `python3 -m venv .venv`: creates the virtual environment folder.
- `source .venv/bin/activate`: switches this terminal to use the venv's Python and pip.
- `pip index versions <name>`: shows the newest version of a package.
- `pip install -r requirements.txt`: installs every package listed in the file.
- `pip list`: shows what's installed in the active environment.
- `which python`: shows which Python the terminal is using (should be inside `.venv`).

### Milestone 1, Step 3: `main.py` with `/ping`
We created the FastAPI app and one endpoint, `GET /ping`, which returns `{"status": "ok"}` so we can check the server is running. We started it with uvicorn on `127.0.0.1:8000` and confirmed with curl that it answers with status 200, while an unknown URL gets 404.

Commands (run from `backend/`, venv active):
- `uvicorn main:app --reload --host 127.0.0.1 --port 8000`: starts the server. `main:app` = "the `app` variable in `main.py`"; `--reload` restarts it when you save a file. Stop with Ctrl+C.
- `curl -s localhost:8000/ping`: sends a GET request and prints the body. `-s` hides the progress bar.
- `curl -s -i localhost:8000/ping`: same, but `-i` also shows the status line and headers.

### Milestone 1, Step 4: loading `.env`
`main.py` now calls `load_dotenv()` at startup, which copies the lines in `backend/.env` into environment variables so later code can read the Gemini key with `os.getenv` without the key ever being in the code. We proved it loads by printing only True/False for "is it set", never the value, from two different starting folders.

Commands:
- `grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' .env`: lists the variable names in `.env` without their values.
- `python -c "..."`: runs a one-line Python snippet; we used it to print whether each variable is set (True/False).

## Milestone 2: mock `/analyze`

### Milestone 2, Step 1: `samples/request.json`
We wrote an example request body with an optional `url` and 3 original paragraphs about Riverton's bike lane vote, using plain ASCII only. It contains one sentence of each role (main point, evidence, background, counterpoint) so the mock response can quote them exactly.

Commands:
- `python3 - <<'EOF' ... EOF`: runs a short Python script typed straight into the terminal; we used it to check the file is valid JSON and within the 80-paragraph / 20,000-character limits.

### Milestone 2, Step 2: `models.py`
We wrote the API contract as four Pydantic models: `AnalyzeRequest`, `Highlight`, `AnalyzeResponse` and `ErrorResponse`. We proved the sample request passes and that a wrong role, too many or zero core phrases, and a negative paragraph index are all rejected.

Commands:
- `python - <<'EOF' ... EOF` (venv active): ran a test script that builds models from good and bad data and prints whether each was accepted or rejected.

### Milestone 2, Step 3: hardcoded `POST /analyze`
We added `POST /analyze` to `main.py`; it checks the body against `AnalyzeRequest` and always returns the fixed `MOCK_RESPONSE`, whose 4 highlights quote `samples/request.json` word for word. A script confirmed every `text` is an exact substring of its paragraph and every `core` phrase is inside its `text`, and a malformed body was rejected with 422.

Commands (from `backend/`, venv active, server running):
- `curl -s -X POST localhost:8000/analyze -H "Content-Type: application/json" -d @samples/request.json`: sends the sample file as a POST body. `-X POST` sets the method, `-H` adds a header, `-d @file` sends the file's contents.
- `... | python -m json.tool`: pretty-prints JSON so it's readable.

### Milestone 2, Step 4: `samples/response.json`
We saved the live server's `/analyze` output into `samples/response.json`, pretty-printed, instead of writing it by hand. Checks confirmed it equals the live output, passes the `AnalyzeResponse` model, quotes the request verbatim, and has `outline` equal to the main_point ids.

Commands:
- `curl ... -d @samples/request.json | python -m json.tool --indent 2 > samples/response.json`: fetch the response, pretty-print it with 2-space indents, save it to the file.
- `head -12 samples/response.json`: shows the first 12 lines of a file.

## Milestone 3: AI reader (Gemini)

### Milestone 3, Step 1: read the Gemini docs and install the SDK
We read Google's current structured-output docs and installed `google-genai==3.3.0`. The first install failed because the newest `cryptography` has no prebuilt wheel for Intel Macs, so we pinned `cryptography==48.0.1`, which does (later raised to `cryptography==50.0.2` in a security review: 48.0.1 has published advisories (pip-audit: PYSEC-2026-3552, -3553, -3554), so on an Intel Mac install Rust first and let it build from source); we also confirmed from the installed SDK that `genai.Client` takes `api_key=` and that timeouts are set in milliseconds via `HttpOptions(timeout=...)`.

Key syntax from the docs:
- `client.models.generate_content(model=..., contents=..., config={"response_mime_type": "application/json", "response_json_schema": Model.model_json_schema()})`
- read back with `Model.model_validate_json(response.text)`

Commands:
- `pip index versions google-genai`: newest version of the SDK.
- `pip install --dry-run --ignore-installed -r requirements.txt`: shows what pip *would* install, without installing; we used it to find who needed cryptography.
- `pip install --dry-run --ignore-installed --only-binary=cryptography -r requirements.txt`: same, but only allows prebuilt wheels, which revealed 48.0.1.
- `pip check`: confirms all installed packages' requirements are satisfied.

### Milestone 3, Step 2: `scripts/try_gemini.py`
We wrote a standalone script that sends the 3 sample paragraphs, numbered and fenced in delimiters, to Gemini with a JSON schema built from a Pydantic model (no `id`, since ids are ours), then validates the reply. After `gemini-3.8-flash` kept timing out (504) and `gemini-2.5-flash` turned out to be retired (404), we listed the models our key can see, probed three with a tiny "hi" prompt, and switched to `gemini-3.6-flash`, which returned valid, verbatim JSON in 8 seconds.

Lesson: a model being listed doesn't mean it will answer; test with a tiny prompt before blaming your code. Fast 4xx = your request is wrong; slow 504 or 503 = the server's problem.

Commands (from `backend/`, venv active):
- `python scripts/try_gemini.py`: runs the one Gemini call and prints the raw and validated reply.
- `grep -E '^GEMINI_MODEL=' .env`: shows just the model line (never use this on the key line).
- `python -c "from dotenv import dotenv_values; ..."`: shows exactly how python-dotenv reads a value (it strips the space after `=`).

### Milestone 3, Step 3: `prompts.py`
We moved the prompt into `backend/prompts.py` as one template constant, `ANALYZE_PROMPT`, with an `{article}` placeholder, and added our "roughly 20% overall" highlight rule to it. The script now imports it, so there is one source of truth; it still returns valid JSON, and braces inside article text can't break the template.

Commands (from `backend/`, venv active):
- `python -c "from prompts import ANALYZE_PROMPT; ..."`: prints or tests the filled-in prompt without calling Gemini (free, instant).
- `python scripts/try_gemini.py | sed -n '/validated/,$p'`: runs the script but shows only the part from "validated" onward.

### Milestone 3, Step 4: `gemini_client.py`
We made `analyze_paragraphs(paragraphs)`, the single function that builds the prompt, calls Gemini with the schema, and returns a validated `GeminiResult`; the Gemini shapes moved into `models.py`. Every possible failure becomes one `GeminiError`, which we proved with a fake model name (caught in 0.3s), while a normal call returned 3 highlights in 5.3s.

Commands:
- `python - <<'EOF' ... EOF` (venv active): a test script that called `analyze_paragraphs` once normally and once with `GEMINI_MODEL` swapped in memory to a fake name.

### Milestone 3, Step 5: wire Gemini into `/analyze`
`/analyze` now sends the request's paragraphs to `analyze_paragraphs()`, numbers the highlights `h0, h1, ...`, builds `outline` from the main_point ids, and returns the contract shape; the mock is gone (still saved in `samples/response.json`). If Gemini fails, the user gets a 502 with a plain `{"error": ...}` and no stack trace, while the server log records only the error type.

Commands (from `backend/`, venv active):
- `curl -s -w "\nstatus: %{http_code}  time: %{time_total}s\n" ...`: like before, but `-w` also prints the status code and how long the request took.
- `GEMINI_MODEL=no-such-model uvicorn main:app ...`: starts the server with one environment variable overridden for that process only (dotenv never overwrites an already-set variable), to force a Gemini failure.

## Milestone 4: validator

### Milestone 4, Step 1: `validator.py`
We wrote two pure functions: `check_request` rejects empty (400), too many paragraphs or too long (413), and `validate` drops highlights that aren't verbatim, are out of range, duplicated, or left with no verbatim core, then sorts into reading order, keeps at most 2 per paragraph, and numbers them `h0, h1, ...` with `outline` = main_point ids. It returns the drop counts instead of logging them, so it stays pure and easy to test.

Commands:
- `python - <<'EOF' ... EOF` (venv active): ran `validate` and `check_request` on hand-made input and printed the results.

### Milestone 4, Step 2: pytest tests
We pinned `pytest==9.2.0` and wrote `tests/test_validator.py` with the 6 requested cases, using real sentences from `samples/request.json` and no Gemini calls. All 7 test runs pass in about 0.15 seconds (the paraphrase test runs twice: a reworded sentence and one that differs only by a curly apostrophe).

Commands (from `backend/`, venv active):
- `pytest -q`: runs all tests quietly; one dot per passing test.
- `pytest -v`: verbose; one line per test with PASSED/FAILED.

### Milestone 4, Step 3: validator wired into `/analyze`, error JSON everywhere
`/analyze` now rejects empty (400) and oversized (413) requests before calling Gemini, runs every Gemini reply through `validate()`, and logs one line of counts and lengths (never text). Three exception handlers make every other error (bad body 422, unknown URL 404, wrong method 405, unexpected bug 500) return our plain `{"error": ...}` shape, and library logging was turned down to warnings so logs stay clean.

Commands (from `backend/`, server running):
- `curl -s -w "   <- status %{http_code}" -X POST ... -d '{"paragraphs": []}'`: sends a hand-written body and prints the status after the response.
- `python -c 'import json; print(json.dumps({"paragraphs": ["x"] * 81}))'`: generates a big test body without typing it.
- `grep -vE "pattern" file`: prints lines that do NOT match the pattern (used to hide startup noise in the log).

## Milestone 5: MongoDB cache

### Milestone 5, Step 1: PyMongo installed and connected to Atlas
We read the current PyMongo docs, pinned `pymongo==4.20.0` (it brings `dnspython` for `mongodb+srv://` addresses), and tested a connection with a 2-second limit. It first failed with `CERTIFICATE_VERIFY_FAILED` because python.org's Python on macOS has no trusted root certificates, so we pinned `certifi` and pass `tlsCAFile=certifi.where()`; the connection then succeeded in 0.8 to 1.2 seconds.

Lesson: a "timeout" error can hide a different cause; a longer diagnostic run that prints the error *kind* (with secrets masked) found the real problem.

Security note: the MongoDB password was accidentally shared in chat via an editor selection, so we rotated it in Atlas. Close or deselect `.env` before sending messages.

Commands:
- `pip install --dry-run pymongo`: showed pymongo would also install dnspython.
- `python - <<'EOF' ... EOF`: connection test printing only "connected: yes/no", time, and error type (never the URI).

### Milestone 5, Step 2: `db.py`
We wrote the cache: `article_hash` (SHA-256 of the paragraphs), `get_cached`, and `save`, which stores only `_id`, `highlights`, `outline`, `created_at` in `skimatic.analyses` with a 7-day TTL index. Tested save/get, the stored fields, the TTL index, and that an unreachable database returns "no cache" in 0.08s and then is skipped for 60s.

Commands:
- `python - <<'EOF' ... EOF`: tested `db.py` with a throwaway key, then deleted the test document.
- `sed -i '' 's/old/new/' db.py`: edits text in a file from the terminal (macOS form).

### Milestone 5, Step 3: cache wired into `/analyze`
`/analyze` now hashes the paragraphs and checks MongoDB first: a hit returns the stored result with `cached: true` and skips Gemini; a miss calls Gemini, validates, saves, and returns `cached: false`. Same request twice: 7.50s (miss) then 0.11s (hit); with a wrong `MONGODB_URI` it still returned 200 in 4.55s straight from Gemini. The stored document has only `_id`, `created_at`, `highlights`, `outline`: no URL, no full paragraphs.

Commands:
- `MONGODB_URI="mongodb+srv://nobody:wrong@does-not-exist.invalid/" uvicorn main:app ...`: runs the server with a broken DB address for that process only, to prove the fallback.

## Team contract (Blair's repo)

### Prompt step 1: new `prompts.py`
`ANALYZE_PROMPT` now uses the team's roles (main / evidence / background / counter), labels paragraphs by their request id, asks for whole sentences copied character for character, at most 2 per paragraph, main 1-3 times (at least once), and actively hunts for counter sentences. A new `SIMPLIFY_PROMPT` asks for 2-4 exact pieces of one sentence, in reading order.

Note: `gold.json` has 11 `main` highlights for one article, which conflicts with the "main 1-3" rule.

### Prompt step 2: Gemini call for the team contract
`gemini_client.py` now has a generic `ask_json()` (JSON mode, schema, temperature 0.2, one retry after 1.5s) and two functions on top: `analyze()` takes `[{"id", "text"}]` and returns `{paragraph_id, text, role}` highlights, and `simplify()` returns 2-4 core pieces. Tested: ids 10/11/12 were echoed correctly, all highlights and simplify pieces were exact and in order, and a fake model raised `GeminiError` after 2 attempts; our old `main.py` no longer imports (it won't travel to Blair's repo).

### Prompt step 3: first evaluation vs gold (gemini-3.6-flash, temperature 0.2, one run)
Analyze: 7 returned, 6 exact (86%, target 90%); only 5% of sentences highlighted (target 10-20%); roles main 1 / evidence 1 / background 0 / counter 4 vs gold 11/4/5/2; precision 67%, recall 18%; it took 31.5s (target ~10s), probably including one retry. Simplify: all 13 successful calls exact and in order, 2/22 identical to gold, median 4.4s (target ~2s); 9 calls failed with a ClientError, very likely the free-tier rate limit.

Commands:
- `PYTHONPATH=. python <scratchpad>/eval_prompts.py` (from `backend/`): throwaway eval script; `PYTHONPATH=.` lets it import our modules from `backend/`.

### Prompt step 4: less stingy analyze, background for setup, simplify keeps qualifiers (NOT YET EVALUATED)
`ANALYZE_PROMPT` now asks for about 1 highlight in every paragraph with a claim, finding, setup or caveat (about 15-20% of sentences), and requires a background highlight in every setup paragraph. `SIMPLIFY_PROMPT` now keeps meaning-changing words inside pieces (not, might, significantly, which group), e.g. "was significantly higher".

The re-run failed: `429 RESOURCE_EXHAUSTED`, i.e. the free tier allows only 20 generate requests per day per model for gemini-3.6-flash, and we used them up (this also explains the 9 "ClientError" simplify failures in step 3). The quota resets in about 3h46m.

### Prompt step 5: no retry on 429, status code in `GeminiError`
`ask_json` no longer retries when Google says 429 (quota/rate limit), because the retry would only burn another request; other failures still get one retry. `GeminiError` now carries `status_code` and a message like `ClientError 429 RESOURCE_EXHAUSTED`. Tested without spending quota: 429 made 1 attempt in 0.4s, a fake model (404) made 2 attempts in 1.8s.

The eval now runs 1 analyze + 6 chosen simplify sentences (7 calls) to fit the 20-per-day free quota.

### Prompt step 6: eval on gemini-3.5-flash blocked
Switching `GEMINI_MODEL` to `gemini-3.5-flash` did not help: Google's 429 named the `gemini-3.6-flash` quota, so on Google's side 3.5-flash requests count against (or are served by) 3.6-flash. The new prompts are still unevaluated; the no-retry-on-429 fix worked (1 attempt).

### Prompt step 7: `prompts_for_repo.py` for Blair's repo
Blair's `llm.py` already does everything our `gemini_client.py` does, so only the prompts travel. `prompts_for_repo.py` holds our tuned `ANALYZE_PROMPT` and `SIMPLIFY_PROMPT` with `{paragraphs}` and `{sentence}` as the only placeholders, an explicit JSON output example with doubled braces, and his `format_paragraphs()` unchanged at the end; verified with `.format()` on dummy values (no Gemini calls).

Commands:
- `string.Formatter().parse(template)`: lists the placeholders a `.format()` template contains.
- `difflib.unified_diff(old, new)`: shows line-by-line differences between two texts.

### Handoff: pushed to the team repo
Cloned `Sohah07/Skimatic` into `~/CS/Skimatic`, branched `backend` off `frontend`, and committed 6 files: our prompts (as `backend/prompts.py`), `test_paragraphs.txt`, `gold.json`, `gold_simplify.json`, a corrected `HANDOFF.md`, and a new root `.gitignore` (the repo had none). The secrets check passed (all 3 parts), and on `secrets checked, push` we pushed only the `backend` branch: commit `5bbd420`, 1 ahead of `frontend`.

Commands:
- `git clone <url> <folder>`, `git checkout frontend`, `git switch -c backend`: get the repo, go to Blair's branch, start our own branch from it.
- `git check-ignore -v <path>`: shows which `.gitignore` rule ignores a file.
- `git diff --cached --name-status`: lists exactly what is staged for the next commit.
- `git push -u origin backend`: uploads the `backend` branch and remembers it as the upstream.
