from typing import NamedTuple

from models import GeminiHighlight, Highlight

MAX_PARAGRAPHS = 80
MAX_TOTAL_CHARS = 20_000
MAX_PER_PARAGRAPH = 2


class ValidationResult(NamedTuple):
    highlights: list[Highlight]
    outline: list[str]
    dropped_highlights: int  # text not verbatim, bad paragraph index, duplicate, or no core left
    dropped_core: int  # core phrases removed because they weren't inside their text
    capped: int  # highlights removed by the per-paragraph cap


def check_request(paragraphs: list[str]) -> tuple[int, str] | None:
    """Return None if the request is acceptable, else (status_code, error_message)."""
    if not paragraphs:
        return 400, "No paragraphs were sent."
    if len(paragraphs) > MAX_PARAGRAPHS:
        return 413, f"Too many paragraphs (max {MAX_PARAGRAPHS})."
    if sum(len(p) for p in paragraphs) > MAX_TOTAL_CHARS:
        return 413, f"Article is too long (max {MAX_TOTAL_CHARS:,} characters)."
    return None


def validate(raw: list[GeminiHighlight], paragraphs: list[str]) -> ValidationResult:
    dropped_highlights = 0
    dropped_core = 0
    seen = set()
    kept = []  # (paragraph, position of text in paragraph, GeminiHighlight)

    for h in raw:
        # An empty string is a substring of everything, so it must be rejected explicitly.
        if not (0 <= h.paragraph < len(paragraphs)) or not h.text.strip():
            dropped_highlights += 1
            continue
        position = paragraphs[h.paragraph].find(h.text)
        if position == -1 or (h.paragraph, h.text) in seen:
            dropped_highlights += 1
            continue

        core = [c for c in h.core if c.strip() and c in h.text]
        dropped_core += len(h.core) - len(core)
        if not core:
            dropped_highlights += 1
            continue

        seen.add((h.paragraph, h.text))
        kept.append((h.paragraph, position, h.model_copy(update={"core": core})))

    kept.sort(key=lambda item: (item[0], item[1]))

    per_paragraph = {}
    capped = 0
    in_order = []
    for paragraph, _, h in kept:
        per_paragraph[paragraph] = per_paragraph.get(paragraph, 0) + 1
        if per_paragraph[paragraph] > MAX_PER_PARAGRAPH:
            capped += 1
            continue
        in_order.append(h)

    highlights = [Highlight(id=f"h{i}", **h.model_dump()) for i, h in enumerate(in_order)]
    outline = [h.id for h in highlights if h.role == "main_point"]
    return ValidationResult(highlights, outline, dropped_highlights, dropped_core, capped)
