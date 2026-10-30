import pytest

from cert_prep_backend.authoring.domain.reading_solver import (
    ReadingSolution,
    ReadingSpan,
    section_asks_for_reading,
    solve_reading_question,
)


@pytest.mark.parametrize("instruction, expected", [
    (None, False), ("", False),
    ("漢字の読み方を選んでください。", True),
    ("ことばのよみかたを答えてください。", True),
    ("（　）に入れる言葉を選んでください。", False),
    ("反対の意味を持つ言葉を選んでください。", False),
    ("文を読んでから答えてください。", False),
])
def test_section_asks_for_reading(instruction, expected) -> None:
    assert section_asks_for_reading(instruction) is expected


def test_editable_normalization_preserves_internal_instruction() -> None:
    from cert_prep_backend.authoring.domain.deterministic_parser import extract_jlpt_question_blocks
    from cert_prep_backend.authoring.domain.models import SourceChunk
    from cert_prep_backend.authoring.domain.normalization import as_editable_question

    instruction = "問題1 読み方を四つの候補から選びなさい。"
    candidate = extract_jlpt_question_blocks([SourceChunk(
        id="chunk", page_number=1,
        text=f"{instruction}\n1 机を整理した。\n1 せいり 2 せり 3 しょうり 4 せいれい",
    )], 1)[0]
    editable = as_editable_question(candidate)
    assert editable.section_instruction == instruction
    assert "section_instruction" not in editable.to_serialized()


def test_unique_reading_and_fixed_rationale() -> None:
    solution = solve_reading_question(
        "絶叫が会場に響いた。",
        ["ぜっこう", "ぜっきょう", "せっきょう", "ぜつきょう"],
        [ReadingSpan("絶叫", "ぜっきょう")],
    )
    assert solution == ReadingSolution(1, "絶叫", "ぜっきょう")
    assert solution.rationale == "「絶叫」的讀音是「ぜっきょう」，所以答案是 2。"


@pytest.mark.parametrize("choices, spans, reason", [
    (["ぜっきょう", "しょうだく"], [
        ReadingSpan("絶叫", "ぜっきょう"), ReadingSpan("承諾", "しょうだく"),
    ], "ambiguous_readings"),
    (["ぜっきょう", "ゼッキョウ"], [ReadingSpan("絶叫", "ぜっきょう")], "ambiguous_readings"),
    (["ぜっこう", "せっきょう"], [ReadingSpan("絶叫", "ぜっきょう")], "no_matching_reading"),
    (["の", "で", "が", "と"], [ReadingSpan("出", "で")], "short_choice"),
    (["しょうだく", "で"], [ReadingSpan("承諾", "しょうだく")], "short_choice"),
    ([], [ReadingSpan("絶叫", "ぜっきょう")], "no_choices"),
    (["１　", "２　で"], [ReadingSpan("出", "で")], "short_choice"),
])
def test_ambiguous_unmatched_or_short_choices_decline(choices, spans, reason) -> None:
    assert solve_reading_question("絶叫を承諾した。", choices, spans) == reason


def test_normalizes_numbers_spaces_and_katakana() -> None:
    solution = solve_reading_question(
        "絶叫が会場に響いた。",
        ["１．　ゼッ　コウ", "２）　ゼッ キョウ", "３、セッキョウ", "４. ゼツキョウ"],
        [ReadingSpan("絶叫", "ゼッキョウ")],
    )
    assert solution == ReadingSolution(1, "絶叫", "ぜっきょう")


def test_multiple_spans_for_one_choice_have_deterministic_surface() -> None:
    spans = [ReadingSpan("同士", "ドウシ"), ReadingSpan("同志", "どうし")]
    first = solve_reading_question("同志と同士。", ["どうし", "とうし"], spans)
    assert first == solve_reading_question("同志と同士。", ["どうし", "とうし"], reversed(spans))
    assert first == solve_reading_question("同志と同士。", ["どうし", "とうし"], [*spans, *spans])


def test_short_choices_do_not_consume_spans() -> None:
    def unavailable_spans():
        raise AssertionError("short choices must decline before consuming spans")
        yield

    assert solve_reading_question(
        "校門を出た。", ["の", "で", "が", "と"], unavailable_spans()
    ) == "short_choice"


@pytest.mark.parametrize("marker", [
    "( )", "（　）", "（ ）", "()", "（）", "(\t)", "[]", "[ ]", "［　］",
    "__", "___", "＿＿", "＿＿＿", "_＿_", "★", "……", "………", "ーー", "ーーー",
])
def test_blank_stems_decline(marker) -> None:
    assert solve_reading_question(
        f"今日は雨なので、{marker}を持って出かけます。",
        ["あめ", "かさ", "くつ", "かばん"],
        [ReadingSpan("雨", "アメ")],
    ) == "blank_marker"


def test_blank_stems_do_not_consume_spans() -> None:
    def unavailable_spans():
        raise AssertionError("blank stems must decline before consuming spans")
        yield

    assert solve_reading_question(
        "今日は雨なので、（　）を持って出かけます。",
        ["あめ", "かさ", "くつ", "かばん"], unavailable_spans(),
    ) == "blank_marker"


@pytest.mark.parametrize("stem", [
    "スーパーで絶叫した。", "コーヒーを飲んで絶叫した。", "スーーーパーで絶叫した。",
    "絶叫（ぜっきょう）が響いた。", "「絶叫」…という声がした。",
])
def test_reading_stems_with_long_vowels_or_nonblank_brackets_still_answer(stem) -> None:
    assert solve_reading_question(
        stem, ["ぜっきょう", "まちがい"], [ReadingSpan("絶叫", "ゼッキョウ")],
    ) == ReadingSolution(0, "絶叫", "ぜっきょう")
