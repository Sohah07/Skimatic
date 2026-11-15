from typing import Literal

from pydantic import BaseModel, Field  # pyright: ignore[reportMissingImports]

Role = Literal["main_point", "evidence", "background", "counterpoint"]


class AnalyzeRequest(BaseModel):
    url: str | None = None
    paragraphs: list[str]


class Highlight(BaseModel):
    id: str
    paragraph: int = Field(ge=0)
    text: str
    role: Role
    core: list[str] = Field(min_length=1, max_length=3)


class AnalyzeResponse(BaseModel):
    highlights: list[Highlight]
    outline: list[str]
    cached: bool = False


class ErrorResponse(BaseModel):
    error: str


# What we ask Gemini for: like Highlight but without `id`
# (ids are assigned in our code after validation, never by Gemini).
class GeminiHighlight(BaseModel):
    paragraph: int = Field(ge=0)
    text: str
    role: Role
    core: list[str] = Field(min_length=1, max_length=3)


class GeminiResult(BaseModel):
    highlights: list[GeminiHighlight]
