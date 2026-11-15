import hashlib
import json
import logging
import os
import time
from datetime import datetime, timezone

import certifi  # pyright: ignore[reportMissingImports]
from pymongo import MongoClient  # pyright: ignore[reportMissingImports]
from pymongo.server_api import ServerApi  # pyright: ignore[reportMissingImports]

TIMEOUT_MS = 2000
TTL_SECONDS = 7 * 24 * 60 * 60
RETRY_AFTER_SECONDS = 60  # after a failure, skip the DB for a while so requests aren't slowed

logger = logging.getLogger("skimatic")
_collection = None
_down_until = 0.0


def article_hash(paragraphs: list[str]) -> str:
    # json.dumps keeps paragraph boundaries unambiguous: ["a b"] and ["a", "b"] hash differently.
    return hashlib.sha256(json.dumps(paragraphs).encode("utf-8")).hexdigest()


def _get_collection():
    """Return the analyses collection, or None if the DB is unconfigured or recently failed."""
    global _collection
    if _collection is not None:
        return _collection
    uri = os.getenv("MONGODB_URI")
    if not uri or time.monotonic() < _down_until:
        return None
    client = MongoClient(uri, server_api=ServerApi("1"), timeoutMS=TIMEOUT_MS, tlsCAFile=certifi.where())
    collection = client["skimatic"]["analyses"]
    collection.create_index("created_at", expireAfterSeconds=TTL_SECONDS)  # no-op if it already exists
    _collection = collection
    return _collection


def _mark_down(action: str, e: Exception) -> None:
    global _collection, _down_until
    _collection = None
    _down_until = time.monotonic() + RETRY_AFTER_SECONDS
    logger.warning("MongoDB %s failed (%s); skipping cache for %ds", action, type(e).__name__, RETRY_AFTER_SECONDS)


def get_cached(key: str) -> dict | None:
    """Return {"highlights": [...], "outline": [...]} for this hash, or None (miss or DB problem)."""
    try:
        collection = _get_collection()
        if collection is None:
            return None
        return collection.find_one({"_id": key}, {"_id": 0, "highlights": 1, "outline": 1})
    except Exception as e:  # any DB problem means "no cache", never a failed request
        _mark_down("read", e)
        return None


def save(key: str, highlights: list[dict], outline: list[str]) -> None:
    """Store a validated result under its hash. Never raises."""
    try:
        collection = _get_collection()
        if collection is None:
            return
        doc = {"highlights": highlights, "outline": outline, "created_at": datetime.now(timezone.utc)}
        collection.replace_one({"_id": key}, doc, upsert=True)
    except Exception as e:  # any DB problem means "no cache", never a failed request
        _mark_down("write", e)
