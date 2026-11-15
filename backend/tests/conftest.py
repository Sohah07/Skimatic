"""Shared test setup: mock mode, empty caches and no retry pause for every test."""

import os

os.environ["MOCK_LLM"] = "1"  # must happen before llm.py is imported

import pytest  # noqa: E402

import llm  # noqa: E402
import main  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_state(monkeypatch):
    # The caches live for the whole process; clear them so tests can't see each other's answers.
    main.ANALYZE_CACHE.clear()
    main.SIMPLIFY_CACHE.clear()
    monkeypatch.setattr(llm, "RETRY_DELAY_SECONDS", 0)
    yield
