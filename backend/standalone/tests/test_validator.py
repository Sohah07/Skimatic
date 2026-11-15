import json
import sys
from pathlib import Path

import pytest  # pyright: ignore[reportMissingImports]

BACKEND = Path(__file__).parent.parent
# pytest puts tests/ on the import path, not backend/; add backend/ so `import validator` works.
sys.path.insert(0, str(BACKEND))

from models import GeminiHighlight  # noqa: E402
from validator import check_request, validate  # noqa: E402

PARAS = json.loads((BACKEND / "samples" / "request.json").read_text())["paragraphs"]

# Sentences copied exactly from samples/request.json
P0_S1 = "Riverton will convert four miles of downtown parking lanes into protected bike lanes by next summer, the city council decided on Tuesday."
P0_S2 = "The 7-2 vote ends a debate that lasted almost two years."
P0_S3 = "Construction is expected to begin in March."
P1_S1 = "Supporters pointed to the city's own crash data during the meeting."
P2_S2 = "Several downtown shop owners argued that losing 300 parking spaces will drive customers to suburban malls."


def hl(paragraph, text, role="evidence", core=None):
    """Build a fake Gemini highlight; core defaults to the sentence's first word."""
    return GeminiHighlight(paragraph=paragraph, text=text, role=role, core=core or [text.split()[0]])


def test_verbatim_quote_passes():
    result = validate([hl(0, P0_S1, core=["Riverton", "will convert"])], PARAS)

    assert len(result.highlights) == 1
    assert result.highlights[0].text == P0_S1
    assert result.highlights[0].core == ["Riverton", "will convert"]
    assert result.dropped_highlights == 0


@pytest.mark.parametrize("not_verbatim", [
    "Riverton plans to turn four miles of parking into bike lanes.",           # paraphrase
    "Supporters pointed to the city’s own crash data during the meeting.",  # curly apostrophe only
])
def test_paraphrased_quote_is_dropped(not_verbatim):
    result = validate([hl(0, not_verbatim), hl(1, not_verbatim)], PARAS)

    assert result.highlights == []
    assert result.dropped_highlights == 2


def test_core_phrase_not_in_sentence_is_dropped():
    result = validate([hl(0, P0_S1, core=["Riverton", "will build"])], PARAS)

    assert result.highlights[0].core == ["Riverton"]
    assert result.dropped_core == 1


def test_third_highlight_in_one_paragraph_is_dropped():
    raw = [hl(0, P0_S3), hl(0, P0_S1), hl(0, P0_S2)]
    result = validate(raw, PARAS)

    assert [h.text for h in result.highlights] == [P0_S1, P0_S2]  # first two in reading order
    assert result.capped == 1


def test_empty_paragraphs_returns_error():
    status, message = check_request([])

    assert status == 400
    assert message  # a plain, non-empty message for the {"error": ...} body


def test_ids_and_outline_in_reading_order():
    # Deliberately shuffled: Gemini may list highlights in any order.
    raw = [
        hl(2, P2_S2, role="counterpoint"),
        hl(0, P0_S2, role="background"),
        hl(1, P1_S1, role="main_point"),
        hl(0, P0_S1, role="main_point"),
    ]
    result = validate(raw, PARAS)

    assert [(h.id, h.text) for h in result.highlights] == [
        ("h0", P0_S1),
        ("h1", P0_S2),
        ("h2", P1_S1),
        ("h3", P2_S2),
    ]
    assert result.outline == ["h0", "h2"]
