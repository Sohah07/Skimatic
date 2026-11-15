"""Security gate item 2: malformed and oversized requests (see SECURITY_GATE)."""

from fastapi.testclient import TestClient

import main

client = TestClient(main.app)
FORMAT_MSG = "The request wasn't in the expected format."


def test_malformed_bodies_get_one_plain_sentence():
    for body in ({}, {"paragraphs": "not a list"}, {"paragraphs": [{"id": "x", "text": 123}]}):
        r = client.post("/analyze", json=body)
        assert r.status_code == 422
        assert r.json() == {"detail": FORMAT_MSG}


def test_invalid_json_gets_the_same_sentence():
    r = client.post("/analyze", content=b"garbage{", headers={"Content-Type": "application/json"})
    assert r.status_code == 422 and r.json() == {"detail": FORMAT_MSG}


def test_422_never_echoes_the_input():
    long_sentence = "word " * 5000  # 25,000 characters, over the 2,000 limit
    r = client.post("/simplify", json={"sentence": long_sentence})
    assert r.status_code == 422
    assert "word word" not in r.text and len(r.content) < 200


def test_body_over_1mb_is_413_before_parsing():
    big = b'{"paragraphs":[{"id":0,"text":"' + b"a" * 1_200_000 + b'"}]}'
    r = client.post("/analyze", content=big, headers={"Content-Type": "application/json"})
    assert r.status_code == 413 and r.json() == {"detail": "This request is too large."}


def test_chunked_body_over_1mb_is_413():
    def chunks():  # no Content-Length header: sent in pieces
        yield b'{"paragraphs":[{"id":0,"text":"'
        for _ in range(12):
            yield b"a" * 100_000
        yield b'"}]}'
    r = client.post("/analyze", content=chunks(), headers={"Content-Type": "application/json"})
    assert r.status_code == 413


def test_normal_requests_still_work_under_the_cap():
    paras = [{"id": i, "text": f"Sentence number {i} is here. Another one follows."} for i in range(5)]
    r = client.post("/analyze", json={"paragraphs": paras})
    assert r.status_code == 200 and r.json()["highlights"]
