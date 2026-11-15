"""Talks to Gemini (the "chef"). Falls back to fake results in mock mode."""

import asyncio
import json
import logging
import os
import re

from dotenv import load_dotenv

import prompts

load_dotenv()

log = logging.getLogger("skimatic.llm")

API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
MODEL = os.getenv("GEMINI_MODEL", "").strip() or "gemini-3.6-flash"
MOCK = os.getenv("MOCK_LLM", "").strip() == "1" or not API_KEY

ROLES = ("main", "evidence", "background", "counter")

# One Gemini call may take this long before we give up on it (seconds).
TIMEOUT_SECONDS = 60
# Wait this long before the single retry. Tests set it to 0.
RETRY_DELAY_SECONDS = 1.5

_client = None


def _get_client():
    global _client
    if _client is None:
        from google import genai

        _client = genai.Client(api_key=API_KEY)
    return _client


# ---------------------------------------------------------------------------
# Sorting Gemini errors into a few kinds we can act on
# ---------------------------------------------------------------------------

def describe(exc: Exception) -> str:
    """A log-safe description of an error: its type, HTTP code and status only.

    Security gate 7.1: an error MESSAGE could quote the request, i.e. article
    text, and Render keeps logs. So we never log the message itself.
    e.g. "ClientError 400 INVALID_ARGUMENT".
    """
    parts = [type(exc).__name__, getattr(exc, "code", None), getattr(exc, "status", None)]
    return " ".join(str(p) for p in parts if p not in (None, ""))


def error_kind(exc: Exception) -> str:
    """Put an exception into one bucket: quota, rate_limit, bad_key, bad_model,
    timeout, server or other.

    Both quota and rate_limit are HTTP 429. Gemini names the exhausted quota in
    the error text: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" means the
    ~20-a-day free quota is gone (quota); anything else is the per-minute limit
    (rate_limit), which clears by itself after about a minute.

    google-genai raises errors.APIError with .code (HTTP status) and .status
    (e.g. "RESOURCE_EXHAUSTED"). We read them with getattr so this also works
    for fake errors in tests and doesn't crash on plain exceptions.
    """
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return "timeout"
    if type(exc).__name__ in ("ReadTimeout", "ConnectTimeout", "TimeoutException"):
        return "timeout"  # httpx timeouts, without importing httpx here

    code = getattr(exc, "code", None)
    status = str(getattr(exc, "status", "") or "").upper()
    text = str(exc).lower()

    if code == 429 or "RESOURCE_EXHAUSTED" in status:
        return "quota" if "perday" in text else "rate_limit"
    # Google answers a wrong key with 400 "API key not valid" (or 401/403).
    if code in (401, 403) or "api key" in text or "api_key_invalid" in text:
        return "bad_key"
    if code == 404 or status == "NOT_FOUND":
        return "bad_model"
    if isinstance(code, int) and 500 <= code < 600:
        return "server"
    return "other"


def is_transient(exc: Exception) -> bool:
    """Worth one retry? Only timeouts and Google-side 5xx.

    Never a 429: a used-up daily quota can't recover, and the per-minute limit
    asks us to wait ~40 s, far longer than our short pause. Retrying either one
    would just spend another call from the daily quota.
    """
    return error_kind(exc) in ("timeout", "server")


# ---------------------------------------------------------------------------
# The actual call
# ---------------------------------------------------------------------------

async def _generate(prompt: str) -> str:
    """One raw Gemini request. Returns the reply text. Tests replace this function."""
    from google.genai import types

    resp = await asyncio.wait_for(
        _get_client().aio.models.generate_content(
            model=MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                temperature=0.2,
            ),
        ),
        timeout=TIMEOUT_SECONDS,
    )
    return resp.text


async def ask_json(prompt: str) -> dict:
    """Send one prompt to Gemini and parse its JSON reply.

    Retries once after a short pause if the failure looks temporary (timeout,
    5xx). Never retries a 429, a bad key or a missing model: those would fail
    the same way. Only one retry, because the free tier allows ~20 requests a day.
    """
    try:
        text = await _generate(prompt)
    except Exception as e:
        if not is_transient(e):
            raise
        log.warning("Gemini call failed (%s: %s), retrying once", error_kind(e), describe(e))
        await asyncio.sleep(RETRY_DELAY_SECONDS)
        text = await _generate(prompt)
    return json.loads(text)


# ---------------------------------------------------------------------------
# Mock mode: fake but well-formed answers, no API key needed
# ---------------------------------------------------------------------------

# A sentence ends at . ! or ?, plus citation numbers glued to it like ".1,2",
# when the next sentence starts with a capital (same rule as prompt_lab).
_SENTENCE_END = re.compile(r"[.!?](?:[\d,–-]*\d)?(?=\s+[A-Z(])")


def _sentences(text: str) -> list[str]:
    text = text.strip()
    pieces, start = [], 0
    for end in _SENTENCE_END.finditer(text):
        pieces.append(text[start:end.end()])
        start = end.end()
    pieces.append(text[start:])
    return [p.strip() for p in pieces if p.strip()]


def mock_analyze(paragraphs) -> dict:
    """Fake but well-formed result: first sentence of each paragraph, cycling roles."""
    highlights = []
    for i, p in enumerate(paragraphs):
        sents = _sentences(p.text)
        if sents:
            highlights.append(
                {"paragraph_id": p.id, "text": sents[0], "role": ROLES[i % len(ROLES)]}
            )
    return {"highlights": highlights}


def mock_simplify(sentence: str) -> dict:
    words = sentence.split()
    return {"core": words[:2] + words[-2:] if len(words) > 4 else words}


async def analyze(paragraphs) -> dict:
    if MOCK:
        return mock_analyze(paragraphs)
    prompt = prompts.ANALYZE_PROMPT.format(
        paragraphs=prompts.format_paragraphs(paragraphs)
    )
    return await ask_json(prompt)


async def simplify(sentence: str) -> dict:
    if MOCK:
        return mock_simplify(sentence)
    return await ask_json(prompts.SIMPLIFY_PROMPT.format(sentence=sentence))
