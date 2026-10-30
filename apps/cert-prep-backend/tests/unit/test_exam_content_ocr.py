import pytest

from cert_prep_backend.source_library.domain.ocr_exam_content import (
    _parse_ocr_jlpt_question_blocks as parse_jlpt_question_blocks,
)

from cert_prep_backend.authoring.domain.deterministic_parser import extract_jlpt_question_blocks
from cert_prep_backend.authoring.domain.models import SourceChunk
from cert_prep_backend.authoring.domain.reading_solver import section_asks_for_reading
from cert_prep_backend.source_library.domain.exam_content import (
    ContentProfile,
    classify_exam_text,
)


@pytest.mark.parametrize("one", ["Ⅰ", "I", "l", "|", "１", "1"])
@pytest.mark.parametrize("separator", ["", " ", "\n"])
def test_ocr_reading_preserves_original_text(one: str, separator: str) -> None:
    instruction = f"問題{one} 漢字の読み方を、{one}２3４からーつ選びなさい。"
    stem = "スーパーでーつだけN Iの印の箱を選んだ。"
    text = (
        f"日本語能力試験NI\n{instruction}(1*6)\n１\n{stem}\n"
        f"{one}はこ{separator}２ばこ{separator}3はご{separator}４ぱこ"
    )
    blocks = parse_jlpt_question_blocks(text=text, page_number=2)
    assert len(blocks) == 1
    block = blocks[0]
    assert block.source_question_number == "1"
    assert block.stem == stem
    assert block.choices == ("1 はこ", "2 ばこ", "3 はご", "4 ぱこ")
    assert block.section_instruction == instruction
    assert section_asks_for_reading(block.section_instruction)
    assert f"{one}はこ" in block.source_excerpt
    assert classify_exam_text(text).content_profile is ContentProfile.JLPT_VOCABULARY


def test_ocr_choices_keep_numerals_long_vowels_and_question_references() -> None:
    text = (
        "５ 問いの内容は何か。\n"
        "Ⅰ問題1を解く２スーパーで２箱買う3ーつ選ぶ４NIの表示を見る\n"
        "問題２ 次の文について答えてください。\n"
        "６ 次の問い。\n1甲2乙3丙4丁"
    )
    blocks = parse_jlpt_question_blocks(text=text, page_number=2)
    assert [block.source_question_number for block in blocks] == ["5", "6"]
    assert blocks[0].choices == (
        "1 問題1を解く", "2 スーパーで２箱買う", "3 ーつ選ぶ", "4 NIの表示を見る",
    )
    assert blocks[1].section_instruction == "問題２ 次の文について答えてください。"


def test_ocr_parser_never_starts_a_question_inside_prose() -> None:
    text = "説明の途中に 27 数字がある。\n1甲2乙3丙4丁"
    assert parse_jlpt_question_blocks(text=text, page_number=1) == []


@pytest.mark.parametrize("text", [
    "問題Ⅰ 読み方を1234からーつ選びなさい。(1*6)",
    "NI\n1 言語知識\n1甲2乙3丙4丁",
    "(1*6)\n1甲2乙3丙4丁",
    "7 読み方を1234からーつ選びなさい。\n1甲2乙3丙4丁",
    "7 問い。\n1甲3丙2乙4丁",
    "7 問い。\n1甲2 3丙4丁",
    "7 問い。\n1甲2乙3丙4" + "あ" * 501,
    "7 問い。\n1甲2乙\n8 次の問い。\n3丙4丁",
])
def test_ocr_parser_rejects_junk_and_incomplete_choices(text: str) -> None:
    assert parse_jlpt_question_blocks(text=text, page_number=1) == []


def test_ocr_extractor_keeps_reading_gate_and_source_characters() -> None:
    instruction = "問題Ⅰ 読み方をⅠ234からーつ選びなさい。"
    chunk = SourceChunk(
        id="ocr", page_number=2,
        text=f"{instruction}(1*6)\n１\n池の水は澄んでいる。\nIすんで2しんで3ずんで4ちんで",
    )
    suggestions = extract_jlpt_question_blocks([chunk], limit=10)
    assert len(suggestions) == 1
    assert suggestions[0].question == "池の水は澄んでいる。"
    assert suggestions[0].section_instruction == instruction
    assert section_asks_for_reading(suggestions[0].section_instruction)


def test_ocr_ordered_choices_do_not_split_question_references() -> None:
    blocks = parse_jlpt_question_blocks(
        text="７ 問題1を確認した。\n1問題2を読む2問題3を考える3問題4を調べる4問題1を解く",
        page_number=1,
    )
    assert len(blocks) == 1
    assert blocks[0].stem == "問題1を確認した。"
    assert blocks[0].choices == (
        "1 問題2を読む", "2 問題3を考える", "3 問題4を調べる", "4 問題1を解く",
    )


def test_ocr_parenthesized_questions_and_dotted_choices() -> None:
    blocks = parse_jlpt_question_blocks(
        text="（２６）何を買ったか。\n１.本２．箱3.紙4．布\n(２7)何を捨てたか。\n1甲2乙3丙4丁",
        page_number=1,
    )
    assert [block.source_question_number for block in blocks] == ["26", "27"]
    assert blocks[0].choices == ("1 本", "2 箱", "3 紙", "4 布")


def test_ocr_glued_question_numbers_do_not_consume_the_next_question() -> None:
    blocks = parse_jlpt_question_blocks(
        text="５本を開いた。\n1ひらいた2あいた3すいた4かわいた\n６窓を閉じた。\n1甲2乙3丙4丁",
        page_number=1,
    )
    assert [block.source_question_number for block in blocks] == ["5", "6"]
    assert blocks[0].stem == "本を開いた。"
    assert blocks[0].choices[-1] == "4 かわいた"


def test_ocr_question_number_cannot_be_borrowed_as_choice_one() -> None:
    blocks = parse_jlpt_question_blocks(
        text="10 未完の問い。\n1甲2乙3丙\n11 完全な問い。\nIこう2おつ3へい4てい",
        page_number=1,
    )
    assert [block.source_question_number for block in blocks] == ["11"]


def test_listening_ordinals_are_boundaries_and_cannot_supply_stems() -> None:
    text = "4 前の選択肢\n2番\nIこう2おつ3へい4てい\n3番\n1甲2乙3丙4丁"
    assert parse_jlpt_question_blocks(text=text, page_number=1) == []
