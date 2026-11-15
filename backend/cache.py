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
