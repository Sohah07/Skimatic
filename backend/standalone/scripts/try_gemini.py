"""Standalone first Gemini call. Run from backend/: python scripts/try_gemini.py"""

import json
import os
import sys
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv  # pyright: ignore[reportMissingImports]
from google import genai  # pyright: ignore[reportMissingImports]
from google.genai import types  # pyright: ignore[reportMissingImports]
from pydantic import BaseModel, Field  # pyright: ignore[reportMissingImports]

BACKEND = Path(__file__).parent.parent
load_dotenv(BACKEND / ".env")

# Python only searches scripts/ for imports when running this file; add backend/ too.
sys.path.insert(0, str(BACKEND))
from prompts import ANALYZE_PROMPT  # noqa: E402


# What we ask Gemini to return: like Highlight in models.py, but no `id`
# (ids are assigned in our code after validation, never by Gemini).
class GeminiHighlight(BaseModel):
    paragraph: int = Field(ge=0)
    text: str
    role: Literal["main_point", "evidence", "background", "counterpoint"]
    core: list[str] = Field(min_length=1, max_length=3)


class GeminiResult(BaseModel):
    highlights: list[GeminiHighlight]


paragraphs = json.loads((BACKEND / "samples" / "request.json").read_text())["paragraphs"]
numbered = "\n\n".join(f"[{i}] {p}" for i, p in enumerate(paragraphs))

prompt = ANALYZE_PROMPT.format(article=numbered)

client = genai.Client(
    api_key=os.getenv("GEMINI_API_KEY"),
    http_options=types.HttpOptions(timeout=20_000),  # milliseconds
)

response = client.models.generate_content(
    model=os.getenv("GEMINI_MODEL"),
    contents=prompt,
    config={
        "response_mime_type": "application/json",
        "response_json_schema": GeminiResult.model_json_schema(),
    },
)

print("--- raw reply text ---")
print(response.text)

result = GeminiResult.model_validate_json(response.text)
print("\n--- validated against GeminiResult: ok ---")
print(json.dumps(result.model_dump(), indent=2))
