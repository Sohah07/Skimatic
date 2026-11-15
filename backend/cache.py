"""A small in-memory cache so the same article or sentence never costs two Gemini calls.

The free Gemini tier allows ~20 requests a day, so re-analyzing an article
the reader already highlighted (page reload, second demo run) must be free.
The cache lives in the server's memory: it is empty after every restart.
"""

import hashlib
import json
import re
from collections import OrderedDict


class LRUCache:
    """Keeps the most recently used `max_size` entries and forgets the oldest."""

    def __init__(self, max_size: int = 256):
        self.max_size = max_size
        self._data: OrderedDict[str, object] = OrderedDict()

    def get(self, key: str):
        """Return the stored value, or None if we never saw this key."""
        if key not in self._data:
            return None
        self._data.move_to_end(key)  # mark as "recently used"
        return self._data[key]

    def put(self, key: str, value) -> None:
        self._data[key] = value
        self._data.move_to_end(key)
        if len(self._data) > self.max_size:
            self._data.popitem(last=False)  # drop the least recently used entry

    def clear(self) -> None:
        self._data.clear()

    def __len__(self) -> int:
        return len(self._data)


def normalize(text: str) -> str:
    """Collapse runs of whitespace so 'a  b\\n' and 'a b' share one cache entry."""
    return re.sub(r"\s+", " ", text).strip()


def short_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def make_key(model: str, prompt_template: str, payload) -> str:
    """sha256 of model name + prompt version + normalized input.

    The "prompt version" is a hash of the prompt text itself, so editing
    prompts.py automatically stops old cached answers from being reused.
    """
    raw = json.dumps(
        {"model": model, "prompt": short_hash(prompt_template), "input": payload},
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


# --- Security gate 7.2: keep positions, never article text ---------------------
# The backend promises it never stores what people read. So cached answers are
# saved as (paragraph id, start, end, role): numbers only. On a repeat request
# the sentences are cut back out of the text that request just sent. Positions
# are counted in the whitespace-normalized text, because the cache key is too.

def to_positions(highlights: list[dict], paragraphs) -> list[tuple]:
    text_of = {p.id: normalize(p.text) for p in paragraphs}
    positions = []
    for h in highlights:
        paragraph = text_of.get(h["paragraph_id"])
        sentence = normalize(h["text"])
        start = paragraph.find(sentence) if paragraph is not None else -1
        if start != -1:
            positions.append((h["paragraph_id"], start, start + len(sentence), h["role"]))
    return positions


def from_positions(positions: list[tuple], paragraphs) -> list[dict]:
    text_of = {p.id: normalize(p.text) for p in paragraphs}
    return [
        {"paragraph_id": pid, "text": text_of[pid][start:end], "role": role}
        for pid, start, end, role in positions
        if pid in text_of
    ]


def core_to_positions(core: list[str], sentence: str) -> list[tuple]:
    text, cursor, positions = normalize(sentence), 0, []
    for piece in core:
        piece = normalize(piece)
        start = text.find(piece, cursor)
        if start != -1:
            positions.append((start, start + len(piece)))
            cursor = start + len(piece)
    return positions


def core_from_positions(positions: list[tuple], sentence: str) -> list[str]:
    text = normalize(sentence)
    return [text[start:end] for start, end in positions]
