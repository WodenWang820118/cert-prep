"""Synthetic regressions for conservative OCR recovery and non-question rejection."""

from dataclasses import replace
import json

import pytest

from cert_prep_backend.source_library.domain import exam_content as primary
from cert_prep_backend.source_library.domain import ocr_exam_content as ocr


def _question(number="７", stem="小舟を岸につないだ。", choices=None):
    choices = choices or ("こぶね", "こふね", "おぶね", "おふね")
    return f"{number}{stem}\nI{choices[0]}2{choices[1]}3{choices[2]}4{choices[3]}"


@pytest.mark.parametrize("choice_count", range(4))
def test_incomplete_item_cannot_consume_a_glued_next_question(choice_count):
    incomplete = "７書きかけの問い。\n" + "I甲2乙3丙"[: choice_count * 2]
    text = incomplete + "\n" + _question("８")
    blocks = ocr._parse_ocr_jlpt_question_blocks(text=text, page_number=1)
    assert [(b.source_question_number, b.stem, b.choices) for b in blocks] == [
        ("8", "小舟を岸につないだ。", ("1 こぶね", "2 こふね", "3 おぶね", "4 おふね"))
    ]


@pytest.mark.parametrize(
    "leading", ["問題Ⅰ 読み方を答えてください。", "問題Ⅰ 読み方を選びなさい。"]
)
def test_prefix_removal_keeps_questions_before_a_second_section(leading):
    second = "問題２ 次の文の空欄に入る語を選びなさい。"
    text = f"{leading}\n{_question()}\n{second}\n{_question('８', '明日は港へ行く。')}"
    blocks = ocr._parse_ocr_jlpt_question_blocks(text=text, page_number=1)
    assert [b.source_question_number for b in blocks] == ["7", "8"]
    assert [b.section_instruction for b in blocks] == [leading, second]
    assert blocks[0].source_excerpt.startswith("７")
    assert blocks[1].stem == "明日は港へ行く。"


def test_later_prompt_cannot_strip_questions_after_page_furniture():
    text = "練習の記録\n" + _question() + "\n問題２ 次の文の語を選びなさい。\n" + _question("８")
    blocks = ocr._parse_ocr_jlpt_question_blocks(text=text, page_number=1)
    assert [b.source_question_number for b in blocks] == ["7", "8"]


@pytest.mark.parametrize("replacement", ["missing", "empty-stem", "empty-choice", "three-choices"])
def test_more_fallback_blocks_cannot_drop_a_complete_primary_number(replacement, monkeypatch):
    block = ocr._parse_ocr_jlpt_question_blocks(text=_question(), page_number=1)[0]
    fallback = [replace(block, source_question_number=str(n)) for n in (8, 9, 10)]
    if replacement == "empty-stem":
        fallback.append(replace(block, stem=" "))
    elif replacement == "empty-choice":
        fallback.append(replace(block, choices=("1 ", *block.choices[1:])))
    elif replacement == "three-choices":
        fallback.append(replace(block, choices=block.choices[:3]))
    monkeypatch.setattr(ocr, "_parse_ocr_jlpt_question_blocks", lambda **_: fallback)
    text = "\n".join(_question(str(n)) for n in (8, 9, 10))
    original = [block]
    assert ocr._select_ocr_question_blocks(primary=original, text=text, page_number=1) is original


def test_preservation_compares_full_width_and_ascii_question_numbers(monkeypatch):
    block = ocr._parse_ocr_jlpt_question_blocks(text=_question(), page_number=1)[0]
    original = [replace(block, source_question_number="７")]
    fallback = [replace(block, source_question_number=str(n)) for n in (7, 8, 9)]
    monkeypatch.setattr(ocr, "_parse_ocr_jlpt_question_blocks", lambda **_: fallback)
    text = "\n".join(_question(str(n)) for n in (7, 8, 9))
    assert ocr._select_ocr_question_blocks(primary=original, text=text, page_number=1) is fallback


def test_recovered_group_prompt_controls_classification():
    text = "問題Ⅰ 次の文の空欄に入る語を選びなさい。\n" + _question()
    blocks = primary.parse_jlpt_question_blocks(text=text, page_number=1)
    assert blocks[0].item_kind == primary.QuestionItemKind.GROUPED_QUESTION
    classification = primary.classify_exam_text(text)
    assert classification.content_profile == primary.ContentProfile.JLPT_GROUPED
    assert json.loads(classification.detail)["grouped_prompt_count"] == 1


def test_classification_uses_recovered_prompts_with_nonempty_primary():
    heading = "問題Ⅰ 次の文の空欄に入る語を選びなさい。"
    text = heading + "\n7 小舟を岸につないだ。\n1 甲\n2 乙\n3 丙\n4 丁\n"
    text += _question("８") + "\n" + _question("９")
    classification = primary.classify_exam_text(text)
    assert classification.content_profile == primary.ContentProfile.JLPT_GROUPED
    assert json.loads(classification.detail)["question_block_count"] == 3


def test_classification_keeps_primary_when_recovery_ties():
    text = "問題Ⅰ 次の文の空欄に入る語を選びなさい。\n7 小舟を岸につないだ。\n1 甲\n2 乙\n3 丙\n4 丁"
    classification = primary.classify_exam_text(text)
    assert classification.content_profile == primary.ContentProfile.JLPT_VOCABULARY
    assert json.loads(classification.detail)["group_prompt_count"] == 0


@pytest.mark.parametrize(
    "stem", ["解答用紙", "解答欄", "受験番号", "氏名", "配点表", "得点表", "ページ ９"]
)
def test_rejects_administrative_page_furniture(stem):
    assert ocr._parse_ocr_jlpt_question_blocks(text=_question(stem=stem), page_number=1) == []


@pytest.mark.parametrize(
    "stem", ["氏名をゆっくり書いた。", "受験番号は後で調べる。", "解答用紙を配った。", "得点表を壁に張る。"]
)
def test_furniture_words_inside_a_real_sentence_remain_content(stem):
    blocks = ocr._parse_ocr_jlpt_question_blocks(text=_question(stem=stem), page_number=1)
    assert len(blocks) == 1
    assert blocks[0].stem == stem


@pytest.mark.parametrize("value", ["９９", "・－？", "（９９）"])
@pytest.mark.parametrize("index", range(4))
def test_rejects_numeric_and_punctuation_only_choice_cells(value, index):
    choices = ["こぶね", "こふね", "おぶね", "おふね"]
    choices[index] = value
    assert ocr._parse_ocr_jlpt_question_blocks(text=_question(choices=choices), page_number=1) == []


@pytest.mark.parametrize("suffix", [" ２番", " 質問 ２", " ２ 番 ふりがな"])
def test_rejects_listening_rows_used_as_stems(suffix):
    text = _question(stem="荷物を並べる" + suffix)
    assert ocr._parse_ocr_jlpt_question_blocks(text=text, page_number=1) == []


def test_rejects_annotation_list_misread_as_choices():
    text = (
        "７語句の説明 （注\n1 ）舟：小型の船 （注\n2 ）岸：水辺 （注\n"
        "3 ）綱：太い縄 （注\n4 ）結ぶ：つなぐ"
    )
    assert ocr._parse_ocr_jlpt_question_blocks(text=text, page_number=1) == []


@pytest.mark.parametrize("index", range(4))
def test_rejects_a_complete_item_embedded_in_a_choice(index):
    choices = ["こぶね", "こふね", "おぶね", "おふね"]
    choices[index] += " ８次の荷物を調べた。1甲2乙3丙4丁"
    assert ocr._parse_ocr_jlpt_question_blocks(text=_question(choices=choices), page_number=1) == []


def test_rejects_a_first_choice_that_restarts_after_a_question_sentence():
    text = _question(choices=("倉庫では何を運ぶか。 Iこぶね", "こふね", "おぶね", "おふね"))
    assert ocr._parse_ocr_jlpt_question_blocks(text=text, page_number=1) == []


def test_rejects_a_nested_complete_item_without_sentence_punctuation():
    text = _question(choices=("こぶね", "こふね", "おぶね", "おふね ８荷物の名前は 1甲2乙3丙4丁"))
    assert ocr._parse_ocr_jlpt_question_blocks(text=text, page_number=1) == []


def test_real_wording_with_ordinals_and_numbers_stays_valid():
    blocks = ocr._parse_ocr_jlpt_question_blocks(
        text="７船団の２番目の舟を選ぶ。\nI 数は９９個\n2 ２番目\n3 ページを開く\n4 配点を調べる",
        page_number=1,
    )
    assert len(blocks) == 1
    assert blocks[0].choices[0] == "1 数は９９個"


@pytest.mark.parametrize(
    "glued_question",
    [
        "７彼は読み方を習った。\nI正しい2誤り3不明4ほか",
        "７彼は読み方を（　）\nI習った2教えた3忘れた4覚えた",
    ],
)
def test_section_instruction_stops_at_a_glued_question_start(glued_question):
    from cert_prep_backend.authoring.domain.reading_solver import section_asks_for_reading

    heading = "問題Ⅰ 文章の内容について答えてください"
    blocks = ocr._parse_ocr_jlpt_question_blocks(
        text=f"{heading}\n{glued_question}", page_number=1
    )
    assert [b.source_question_number for b in blocks] == ["7"]
    assert "読み方" not in (blocks[0].section_instruction or "")
    assert not section_asks_for_reading(blocks[0].section_instruction)


@pytest.mark.parametrize(
    "continuation",
    ["読み方として最もよいものを選びなさい。", "4つの中から読み方を選びなさい。"],
)
def test_wrapped_instruction_lines_are_still_collected(continuation):
    from cert_prep_backend.authoring.domain.reading_solver import section_asks_for_reading

    text = f"問題１ 次の言葉について\n{continuation}\n{_question()}"
    blocks = ocr._parse_ocr_jlpt_question_blocks(text=text, page_number=1)
    assert [b.source_question_number for b in blocks] == ["7"]
    assert section_asks_for_reading(blocks[0].section_instruction)


def _recoverable_text(count=5):
    return "\n".join(_question(str(n)) for n in range(1, count + 1))


def test_preservation_counts_repeated_question_numbers(monkeypatch):
    block = ocr._parse_ocr_jlpt_question_blocks(text=_question(), page_number=1)[0]
    first = replace(block, source_question_number="1", stem="最初の問題です。")
    second = replace(block, source_question_number="1", stem="別の大題の問題です。")
    fallback = [first] + [replace(block, source_question_number=str(n)) for n in (2, 3, 4)]
    monkeypatch.setattr(ocr, "_parse_ocr_jlpt_question_blocks", lambda **_: fallback)
    original = [first, second]
    assert (
        ocr._select_ocr_question_blocks(primary=original, text=_recoverable_text(), page_number=1)
        is original
    )


def test_preservation_requires_the_same_question_not_only_its_number(monkeypatch):
    block = ocr._parse_ocr_jlpt_question_blocks(text=_question(), page_number=1)[0]
    original = [replace(block, source_question_number="7", stem="元の問題です。")]
    fallback = [replace(block, source_question_number="7", stem="違う問題です。")] + [
        replace(block, source_question_number=str(n)) for n in (8, 9)
    ]
    monkeypatch.setattr(ocr, "_parse_ocr_jlpt_question_blocks", lambda **_: fallback)
    assert (
        ocr._select_ocr_question_blocks(primary=original, text=_recoverable_text(), page_number=1)
        is original
    )


def test_preservation_accepts_every_repeated_primary_question(monkeypatch):
    block = ocr._parse_ocr_jlpt_question_blocks(text=_question(), page_number=1)[0]
    first = replace(block, source_question_number="1", stem="最初の問題です。")
    second = replace(block, source_question_number="1", stem="別の大題の問題です。")
    fallback = [first, second, replace(block, source_question_number="2")]
    monkeypatch.setattr(ocr, "_parse_ocr_jlpt_question_blocks", lambda **_: fallback)
    assert (
        ocr._select_ocr_question_blocks(
            primary=[first, second], text=_recoverable_text(), page_number=1
        )
        is fallback
    )


@pytest.mark.parametrize(
    "merged_stem",
    ["順応 （8）彼の活躍は目覚ましい。", "元祖 8）一年で一番忙しい時期だ。", "起伏 (13）森さんは話を聞いた。"],
)
def test_merged_primary_items_do_not_block_a_better_recovery(merged_stem, monkeypatch):
    block = ocr._parse_ocr_jlpt_question_blocks(text=_question(), page_number=1)[0]
    original = [replace(block, source_question_number="4", stem=merged_stem)]
    fallback = [replace(block, source_question_number=str(n)) for n in (4, 5, 6)]
    monkeypatch.setattr(ocr, "_parse_ocr_jlpt_question_blocks", lambda **_: fallback)
    assert (
        ocr._select_ocr_question_blocks(primary=original, text=_recoverable_text(), page_number=1)
        is fallback
    )


def test_complete_primary_question_with_a_numeric_answer_stays_protected(monkeypatch):
    block = ocr._parse_ocr_jlpt_question_blocks(text=_question(), page_number=1)[0]
    numeric = replace(
        block,
        source_question_number="9",
        stem="箱の中にりんごはいくつありますか。",
        choices=("1 甲", "2 乙", "3 丙", "4 16"),
    )
    fallback = [replace(block, source_question_number=str(n)) for n in (6, 7, 8)]
    monkeypatch.setattr(ocr, "_parse_ocr_jlpt_question_blocks", lambda **_: fallback)
    assert (
        ocr._select_ocr_question_blocks(primary=[numeric], text=_recoverable_text(), page_number=1)
        == [numeric]
    )


@pytest.mark.parametrize(
    "noise",
    ["１ 甲 ２ 乙 ３ 丙 " * 300, "１ 甲\n２ 乙\n３ 丙\n" * 100, "I甲2乙3丙" * 300],
)
def test_noisy_labels_without_a_fourth_choice_do_not_backtrack(noise):
    import time

    started = time.perf_counter()
    primary.parse_jlpt_question_blocks(text="７問い。\n" + noise, page_number=1)
    assert time.perf_counter() - started < 2.0


@pytest.mark.parametrize(
    "choices",
    [("日本", "中国", "韓国", "台湾"), ("人間", "動物", "植物", "鉱物"), ("日曜日", "月曜日", "火曜日", "水曜日"), ("年金", "給料", "貯金", "税金")],
)
def test_glued_labels_before_words_that_start_with_counter_characters(choices):
    text = _question("７", "明日はどこへ行くか。", choices)
    blocks = primary.parse_jlpt_question_blocks(text=text, page_number=1)
    assert [(b.source_question_number, b.choices) for b in blocks] == [
        ("7", tuple(f"{i} {word}" for i, word in enumerate(choices, start=1)))
    ]
