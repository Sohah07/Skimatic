import os
import time
from typing import Literal

from google import genai  # pyright: ignore[reportMissingImports]
from google.genai import errors, types  # pyright: ignore[reportMissingImports]
from pydantic import BaseModel, Field  # pyright: ignore[reportMissingImports]

from prompts import ANALYZE_PROMPT, SIMPLIFY_PROMPT

TIMEOUT_MS = 20_000
TEMPERATURE = 0.2
RETRY_PAUSE_SECONDS = 1.5


class GeminiError(Exception):
    """Any Gemini failure after the one retry: timeout, overload, bad model name, or a reply that doesn't fit the schema.

    `status_code` is Google's HTTP code (e.g. 429, 504) when there is one, else None.
    """

    def __init__(self, cause: Exception):
        self.status_code = getattr(cause, "code", None) if isinstance(cause, errors.APIError) else None
        label = type(cause).__name__
        if self.status_code:
            label += f" {self.status_code} {getattr(cause, 'status', '') or ''}".rstrip()
        super().__init__(label)


# Shapes we ask Gemini for (the team contract's roles; no ids, no core in analyze).
class AnalyzeHighlight(BaseModel):
    paragraph_id: int
    text: str
    role: Literal["main", "evidence", "background", "counter"]


class AnalyzeResult(BaseModel):
    highlights: list[AnalyzeHighlight]


class SimplifyResult(BaseModel):
    core: list[str] = Field(min_length=2, max_length=4)


def ask_json(prompt: str, schema: type[BaseModel]) -> BaseModel:
    """One Gemini call in JSON mode, validated against `schema`. One retry after a short pause."""
    # Built per call, not at import time, so it reads the key after .env has been loaded.
    client = genai.Client(
        api_key=os.getenv("GEMINI_API_KEY"),
        http_options=types.HttpOptions(timeout=TIMEOUT_MS),
    )
    config = {
        "temperature": TEMPERATURE,
        "response_mime_type": "application/json",
        "response_json_schema": schema.model_json_schema(),
    }
    last_error = None
    for attempt in range(2):
        if attempt:
            time.sleep(RETRY_PAUSE_SECONDS)
        try:
            response = client.models.generate_content(
                model=os.getenv("GEMINI_MODEL"), contents=prompt, config=config
            )
            return schema.model_validate_json(response.text)
        except errors.APIError as e:
            last_error = e
            if e.code == 429:  # quota/rate limit: retrying only burns another request
                break
        except Exception as e:
            last_error = e
    raise GeminiError(last_error) from last_error


def analyze(paragraphs: list[dict]) -> list[dict]:
    """paragraphs: [{"id": 0, "text": "..."}]. Returns raw highlights: [{"paragraph_id", "text", "role"}] (unfiltered)."""
    article = "\n\n".join(f"[{p['id']}] {p['text']}" for p in paragraphs)
    result = ask_json(ANALYZE_PROMPT.format(article=article), AnalyzeResult)
    return [h.model_dump() for h in result.highlights]


def simplify(sentence: str) -> list[str]:
    """Returns 2-4 core pieces (unfiltered)."""
    result = ask_json(SIMPLIFY_PROMPT.format(sentence=sentence), SimplifyResult)
    return result.core
