import pytest

from cert_prep_backend.authoring.domain.reading_solver import section_asks_for_reading
from cert_prep_backend.source_library.domain.ocr_exam_content import (
    _parse_ocr_jlpt_question_blocks as parse_jlpt_question_blocks,
)


@pytest.mark.parametrize("continuation", ["3人です。", "1.5倍です。"])
@pytest.mark.parametrize("field", ["stem", "c1", "c2", "c3", "c4"])
def test_wrapped_numeric_continuation_keeps_its_question_and_field(
    continuation: str, field: str,
) -> None:
    fields = {"stem": "報告の内容はどれか。", "c1": "人数は三人", "c2": "人数は五人",
              "c3": "割合は半分", "c4": "割合は同じ"}
    fields[field] = f"記録によると\n{continuation}"
    text = (
        f"48 {fields['stem']}\n1 {fields['c1']}\n2 {fields['c2']}\n"
        f"3 {fields['c3']}\n4 {fields['c4']}"
    )
    blocks = parse_jlpt_question_blocks(text=text, page_number=1)
    assert [block.source_question_number for block in blocks] == ["48"]
    assert blocks[0].stem == " ".join(fields["stem"].split())
    assert blocks[0].choices == tuple(
        f"{number} {' '.join(fields[f'c{number}'].split())}" for number in range(1, 5)
    )


@pytest.mark.parametrize("number", [1, 2, 3, 4])
def test_glued_small_question_number_after_complete_choices_is_a_boundary(number: int) -> None:
    blocks = parse_jlpt_question_blocks(
        text=("8 資料をまとめた。\n1 本\n2 箱\n3 棚\n4 紙\n"
              f"{number}扉を閉めた。\n1 しめた\n2 しまた\n3 しれた\n4 しまった"),
        page_number=1,
    )
    assert [block.source_question_number for block in blocks] == ["8", str(number)]
    assert blocks[0].choices[-1] == "4 紙"
    assert blocks[1].stem == "扉を閉めた。"


@pytest.mark.parametrize("field", ["stem", "c1", "c4"])
def test_wrapped_question_verb_is_not_a_numbered_heading(field: str) -> None:
    fields = {"stem": "生徒は何をするか。", "c1": "本を読む", "c4": "窓を開ける"}
    fields[field] = "先生に\n質問する"
    blocks = parse_jlpt_question_blocks(
        text=f"52 {fields['stem']}\n1 {fields['c1']}\n2 紙を配る\n3 黒板を消す\n4 {fields['c4']}",
        page_number=1,
    )
    assert [block.source_question_number for block in blocks] == ["52"]
    assert blocks[0].stem == " ".join(fields["stem"].split())
    assert blocks[0].choices == (
        "1 " + " ".join(fields["c1"].split()), "2 紙を配る", "3 黒板を消す",
        "4 " + " ".join(fields["c4"].split()),
    )


@pytest.mark.parametrize("choice_number", [1, 2, 3, 4])
def test_section_reference_inside_a_choice_is_preserved(choice_number: int) -> None:
    choices = ["図を見る", "表を読む", "式を書く", "本を閉じる"]
    choices[choice_number - 1] = "前の問題1 を確認する"
    text = "53 復習の手順はどれか。\n" + "\n".join(
        f"{number} {choice}" for number, choice in enumerate(choices, 1)
    )
    blocks = parse_jlpt_question_blocks(text=text, page_number=1)
    assert [block.source_question_number for block in blocks] == ["53"]
    assert blocks[0].choices == tuple(
        f"{number} {choice}" for number, choice in enumerate(choices, 1)
    )
    assert blocks[0].section_instruction is None


@pytest.mark.parametrize("choice_number", [1, 2, 3, 4])
def test_quoted_request_in_a_choice_is_a_valid_answer(choice_number: int) -> None:
    choices = ["紙を渡してください", "席に戻ってください", "時計を見てください", "手を挙げてください"]
    choices[choice_number - 1] = "正しい答えを選んでください"
    text = "54 係の人は何と言ったか。\n" + "\n".join(
        f"{number} {choice}" for number, choice in enumerate(choices, 1)
    )
    blocks = parse_jlpt_question_blocks(text=text, page_number=1)
    assert [block.source_question_number for block in blocks] == ["54"]
    assert blocks[0].choices == tuple(
        f"{number} {choice}" for number, choice in enumerate(choices, 1)
    )


@pytest.mark.parametrize("number", ["1", "１", "Ⅰ"])
def test_unseparated_reading_heading_keeps_the_reading_gate(number: str) -> None:
    instruction = f"問題{number}漢字の読み方を答えてください。"
    blocks = parse_jlpt_question_blocks(
        text=f"{instruction}\n7 庭に苗を植えた。\n1 うえた\n2 うえだ\n3 ういた\n4 うれた",
        page_number=1,
    )
    assert [block.source_question_number for block in blocks] == ["7"]
    assert blocks[0].section_instruction == instruction
    assert section_asks_for_reading(blocks[0].section_instruction)


@pytest.mark.parametrize("question_marker", ["7 ", "７\n", "(7)", "7"])
def test_wrapped_numbered_choice_list_stays_in_the_reading_instruction(
    question_marker: str,
) -> None:
    instruction = "問題1 下線の言葉について、\n1・2・3・4から正しい読み方を選びなさい。"
    blocks = parse_jlpt_question_blocks(
        text=f"{instruction}\n{question_marker}瓶の蓋を開けた。\n1 ふた\n2 ぶた\n3 へた\n4 はた",
        page_number=1,
    )
    assert [block.source_question_number for block in blocks] == ["7"]
    assert blocks[0].stem == "瓶の蓋を開けた。"
    assert blocks[0].section_instruction == " ".join(instruction.split())
    assert section_asks_for_reading(blocks[0].section_instruction)
