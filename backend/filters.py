"""Clean up what Gemini returns before it reaches the extension.

The extension finds sentences on the page by exact text match. Anything we
return that isn't copied word for word silently never shows up, so every
highlight and every /simplify piece goes through these filters.
(Ported from the good parts of standalone/validator.py.)
"""

import re

ROLES = {"main", "evidence", "background", "counter"}
MAX_PER_PARAGRAPH = 2


def find_span(needle: str, haystack: str, start: int = 0):
    """Find needle in haystack, forgiving differences in whitespace only.

    Returns (start, end) of the matching piece of *haystack*, or None.
    We always return the haystack's own characters, so "Prices rose" can match
    "Prices  rose" and we hand back "Prices  rose": still an exact substring of
    the page. This matters for the cache (its key ignores whitespace) and for a
    model that tidies up double spaces or line breaks.
    """
    exact = haystack.find(needle, start)
    if exact != -1:
        return exact, exact + len(needle)
    words = needle.split()
    if not words:
        return None
    match = re.compile(r"\s+".join(map(re.escape, words))).search(haystack, start)
    return (match.start(), match.end()) if match else None


def _overlaps(start: int, end: int, spans: list[tuple[int, int]]) -> bool:
    """True if [start, end) shares at least one character with any span."""
    return any(start < s_end and s_start < end for s_start, s_end in spans)


def as_paragraph_id(pid):
    """The paragraph id as an int, or None if it isn't a whole number.

    Models sometimes quote ids ("0") or write them as floats (0.0); the old
    pydantic check accepted those, so we do too. bool is a subclass of int but
    True is not a paragraph id, and a list id like [0] can't be looked up.
    """
    if isinstance(pid, bool):
        return None
    if isinstance(pid, int):
        return pid
    if isinstance(pid, float) and pid.is_integer():
        return int(pid)
    # Only ASCII 0-9: str.isdigit() also accepts superscripts like "²",
    # which int() then rejects with a crash after the Gemini call is spent.
    if isinstance(pid, str) and re.fullmatch(r"[0-9]+", pid.strip()):
        return int(pid.strip())
    return None


def clean_highlights(raw: list, paragraphs) -> list[dict]:
    """Keep only highlights the extension can paint, in article order.

    Rules, applied in the model's order (its first picks win):
      - valid role and a paragraph_id that was in the request
      - non-empty text that appears exactly in that paragraph (whitespace may differ;
        we then return the paragraph's own spelling)
      - no duplicates and no overlap with an already-kept highlight
      - at most MAX_PER_PARAGRAPH per paragraph
    """
    order = {p.id: i for i, p in enumerate(paragraphs)}  # paragraph id -> position
    text_of = {p.id: p.text for p in paragraphs}
    spans: dict[int, list[tuple[int, int]]] = {}  # paragraph id -> kept (start, end)
    kept = []

    for h in raw if isinstance(raw, list) else []:
        if not isinstance(h, dict):
            continue
        pid, role, text = as_paragraph_id(h.get("paragraph_id")), h.get("role"), h.get("text")
        if pid not in text_of:  # None (not a whole number) is never in text_of
            continue
        if role not in ROLES or not isinstance(text, str) or not text.strip():
            continue  # "" is a substring of everything, so reject it explicitly
        span = find_span(text.strip(), text_of[pid])
        if span is None:
            continue  # paraphrased: the extension could never find it
        start, end = span
        text = text_of[pid][start:end]  # the page's own characters
        taken = spans.setdefault(pid, [])
        if len(taken) >= MAX_PER_PARAGRAPH or _overlaps(start, end, taken):
            continue  # duplicates overlap themselves, so this drops them too
        taken.append((start, end))
        kept.append((order[pid], start, {"paragraph_id": pid, "text": text, "role": role}))

    kept.sort(key=lambda item: (item[0], item[1]))  # article order reads nicer
    return [h for _, _, h in kept]


def clean_core(raw: list, sentence: str) -> list[str]:
    """Keep /simplify pieces that are non-empty, exact, in reading order, not overlapping.

    We walk through the sentence with a cursor: each piece must be found
    after the end of the previous one, otherwise it is dropped. As above,
    whitespace may differ and we return the sentence's own characters.
    """
    core = []
    cursor = 0
    for piece in raw if isinstance(raw, list) else []:
        if not isinstance(piece, str) or not piece.strip():
            continue
        span = find_span(piece.strip(), sentence, cursor)
        if span is None:
            continue  # not in the sentence, or out of order / overlapping
        core.append(sentence[span[0]:span[1]])
        cursor = span[1]
    return core
