import pytest

from cert_prep_backend.source_library.domain.exam_content import (
    QuestionItemKind,
    parse_jlpt_question_blocks,
)


READING_INSTRUCTION = "問題1 漢字の読み方を四つの候補から選びなさい。"
OTHER_INSTRUCTION = "問題2 （　）に入れるのによい語を候補から選びなさい。"


def test_nearest_section_instruction_is_independent_of_group_metadata() -> None:
    text = (
        f"{READING_INSTRUCTION}\n"
        "1 机を整理した。\n1 せいり 2 せり 3 しょうり 4 せいれい\n"
        "2 荷物を運んだ。\n1 はこんだ 2 はばんだ 3 はさんだ 4 はらんだ\n"
        f"{OTHER_INSTRUCTION}\n"
        "3 箱（　）本を置いた。\n1 に 2 を 3 で 4 と\n"
        "4 坂（　）登った。\n1 を 2 に 3 で 4 と"
    )
    blocks = parse_jlpt_question_blocks(text=text, page_number=1)
    assert [block.source_question_number for block in blocks] == ["1", "2", "3", "4"]
    assert [block.section_instruction for block in blocks] == [
        READING_INSTRUCTION, READING_INSTRUCTION,
        " ".join(OTHER_INSTRUCTION.split()), " ".join(OTHER_INSTRUCTION.split()),
    ]
    assert {block.item_kind for block in blocks} == {QuestionItemKind.VOCABULARY_SINGLE}
    assert all(block.group_prompt is None and block.group_key is None for block in blocks)


def test_section_context_does_not_leak_between_chunks() -> None:
    item = "1 机を整理した。\n1 せいり 2 せり 3 しょうり 4 せいれい"
    assert parse_jlpt_question_blocks(
        text=f"{READING_INSTRUCTION}\n{item}", page_number=1,
    )[0].section_instruction == READING_INSTRUCTION
    assert parse_jlpt_question_blocks(text=item, page_number=2)[0].section_instruction is None


@pytest.mark.parametrize("instruction", [
    "問題1 読み方を答えてください。",
    "問題１\n漢字のよみかたを\n答えてください。",
    "漢字の読み方を候補から選びなさい。",
    "1 漢字の読み方を候補から選びなさい。",
])
def test_heading_or_recognized_instruction_stem(instruction) -> None:
    blocks = parse_jlpt_question_blocks(
        text=f"{instruction}\n7 机を整理した。\n1 せいり 2 せり 3 しょうり 4 せいれい",
        page_number=1,
    )
    assert len(blocks) == 1
    assert blocks[0].section_instruction == " ".join(instruction.split())


def test_later_heading_without_choose_word_replaces_reading_instruction() -> None:
    other = "問題2 文章の内容について答えてください。"
    blocks = parse_jlpt_question_blocks(
        text=(f"{READING_INSTRUCTION}\n"
              "1 机を整理した。\n1 せいり 2 せり 3 しょうり 4 せいれい\n"
              f"{other}\n7 何を片付けたか。\n1 本 2 机 3 箱 4 棚"),
        page_number=1,
    )
    assert [block.section_instruction for block in blocks] == [READING_INSTRUCTION, other]


def test_reading_word_in_a_later_section_cannot_change_an_earlier_instruction() -> None:
    first = "問題1 文章の内容に合う答えを候補から選びなさい。"
    second = "問題2 漢字の読み方を候補から選びなさい。"
    blocks = parse_jlpt_question_blocks(
        text=(f"{first}\n"
              "1 内容はどれか。\n1 空 2 海 3 山 4 川\n"
              f"{second}\n7 机を整理した。\n1 せいり 2 せり 3 しょうり 4 せいれい"),
        page_number=1,
    )
    assert [block.section_instruction for block in blocks] == [first, second]


def test_inline_items_are_not_part_of_the_heading_instruction() -> None:
    first = "問題1 内容に合う語を候補から選びなさい。"
    second = "問題2 漢字の読み方を候補から選びなさい。"
    blocks = parse_jlpt_question_blocks(
        text=(f"{first} "
              "1 題名はどれか。 1 空 2 海 3 山 4 川 "
              f"{second} 7 机を整理した。 1 せいり 2 せり 3 しょうり 4 せいれい"),
        page_number=1,
    )
    assert [block.section_instruction for block in blocks] == [first, second]


def test_grouping_still_uses_the_first_group_prompt() -> None:
    first = "問題1 __の読み方を候補から選びなさい。"
    second = "問題2 空欄に合う語を候補から選びなさい。"
    blocks = parse_jlpt_question_blocks(
        text=(f"{first}\n"
              "1 机を整理した。\n1 せいり 2 せり 3 しょうり 4 せいれい\n"
              f"{second}\n7 箱（ ）本を置いた。\n1 に 2 を 3 で 4 と"),
        page_number=1,
    )
    assert [block.section_instruction for block in blocks] == [first, second]
    assert {block.group_prompt for block in blocks} == {first}
    assert {block.group_key for block in blocks} == {"page-1:group-1"}
    assert {block.item_kind for block in blocks} == {QuestionItemKind.GROUPED_QUESTION}
