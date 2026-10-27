from cert_prep_backend.source_library.domain.exam_content import (
    ContentProfile,
    QuestionItemKind,
    classify_exam_text,
    parse_jlpt_question_blocks,
)


def test_classifier_identifies_jlpt_vocabulary_single_questions() -> None:
    text = "1 Correct reading? 1 seikai 2 gotou 3 betsu 4 hoka"

    classification = classify_exam_text(text)
    blocks = parse_jlpt_question_blocks(text=text, page_number=2, chunk_index=0)

    assert classification.content_profile is ContentProfile.JLPT_VOCABULARY
    assert len(blocks) == 1
    assert blocks[0].source_order == 20_001
    assert blocks[0].source_question_number == "1"
    assert blocks[0].item_kind is QuestionItemKind.VOCABULARY_SINGLE
    assert blocks[0].group_key is None


def test_classifier_identifies_grouped_question_sets_with_prompt() -> None:
    text = (
        "Mondai 3 Choose the best word for each blank. "
        "12 Sentence with a blank? 1 alpha 2 beta 3 gamma 4 delta "
        "13 Another blank? 1 ichi 2 ni 3 san 4 yon"
    )

    classification = classify_exam_text(text)
    blocks = parse_jlpt_question_blocks(text=text, page_number=5, chunk_index=1)

    assert classification.content_profile is ContentProfile.JLPT_GROUPED
    assert [block.source_order for block in blocks] == [51_001, 51_002]
    assert [block.source_question_number for block in blocks] == ["12", "13"]
    assert {block.item_kind for block in blocks} == {QuestionItemKind.GROUPED_QUESTION}
    assert {block.group_key for block in blocks} == {"page-5:group-3"}
    assert blocks[0].group_prompt is not None


def test_parser_excludes_decorated_matching_page_footer_from_last_choice() -> None:
    for page_number, footer in ((16, "- 16 -"), (27, "― 27 ―")):
        text = (
            "48\n筆者はどのような人か。\n"
            "1 周囲に頼る人\n2 自分を知る人\n3 他者と話す人\n"
            f"4 自分で考える人\n{footer}"
        )

        blocks = parse_jlpt_question_blocks(text=text, page_number=page_number)

        assert len(blocks) == 1
        assert blocks[0].source_question_number == "48"
        assert blocks[0].choices[-1] == "4 自分で考える人"
        assert blocks[0].source_excerpt.endswith("4 自分で考える人")


def test_parser_accepts_dotted_questions_with_split_option_markers() -> None:
    text = (
        "57.仕事はどのような点で異なるか。\n"
        "1\n知識を重視する\n2\n経験を重視する\n"
        "3\n技術を重視する\n4\n人格を重視する\n"
        "58．学生たちにどう影響するか。\n"
        "1\n積極的に参加する\n2\n立場を理解する\n"
        "3\n一緒に作る\n4\n心を開く"
    )

    blocks = parse_jlpt_question_blocks(text=text, page_number=17)

    assert [block.source_question_number for block in blocks] == ["57", "58"]
    assert blocks[0].stem == "仕事はどのような点で異なるか。"
    assert blocks[0].choices == (
        "1 知識を重視する",
        "2 経験を重視する",
        "3 技術を重視する",
        "4 人格を重視する",
    )
    assert blocks[1].stem == "学生たちにどう影響するか。"
    assert blocks[1].choices == (
        "1 積極的に参加する",
        "2 立場を理解する",
        "3 一緒に作る",
        "4 心を開く",
    )
    assert classify_exam_text(text).content_profile is ContentProfile.JLPT_VOCABULARY


def test_parser_preserves_untyped_kana_between_numbered_questions() -> None:
    text = (
        "3\n記事の本文。\n\nきじ\nほんぶん\n\n"
        "57 内容はどれか。\n1 正しい\n2 誤り\n3 不明\n4 ほか\n\n"
        "ないよう\n\n"
        "58 理由はどれか。\n1 時間\n2 場所\n3 人\n4 方法"
    )

    blocks = parse_jlpt_question_blocks(text=text, page_number=18)

    assert [block.source_question_number for block in blocks] == ["57", "58"]
    assert [block.stem for block in blocks] == ["内容はどれか。", "理由はどれか。"]
    assert blocks[0].choices == ("1 正しい", "2 誤り", "3 不明", "4 ほか ないよう")
    assert blocks[1].choices == ("1 時間", "2 場所", "3 人", "4 方法")
    assert "きじ" not in blocks[0].source_excerpt
    assert "ないよう" in blocks[0].source_excerpt
    assert '"question_block_count": 2' in classify_exam_text(text).detail


def test_parser_does_not_borrow_options_after_a_missing_marker() -> None:
    for incomplete_choices in (
        "選択肢の番号がない\n2 二番目\n3 三番目\n4 四番目",
        "1 一番目\n2 二番目\n番号のない三番目\n4 四番目",
    ):
        text = f"48 未完の問い。\n{incomplete_choices}\n49 完全な問い。\n1 甲\n2 乙\n3 丙\n4 丁"

        blocks = parse_jlpt_question_blocks(text=text, page_number=20)

        assert [block.source_question_number for block in blocks] == ["49"]
        assert blocks[0].stem == "完全な問い。"
        assert blocks[0].choices == ("1 甲", "2 乙", "3 丙", "4 丁")


def test_parser_preserves_numbers_that_are_not_confirmed_page_footers() -> None:
    text = "48 答えはどれか。\n1 甲\n2 乙\n3 丙\n4 第16章\n17"
    blocks = parse_jlpt_question_blocks(text=text, page_number=16)
    assert blocks[0].choices[-1] == "4 第16章 17"

    numeric_answer = "48 答えはどれか。\n1 甲\n2 乙\n3 丙\n4\n16"
    blocks = parse_jlpt_question_blocks(text=numeric_answer, page_number=16)
    assert blocks[0].choices[-1] == "4 16"


def test_parser_preserves_inline_kana_and_numeric_choice_text() -> None:
    text = "48 どれか。\n1 12人のほか\n2 23人のなか\n3 34人のそば\n4 45人のため"
    blocks = parse_jlpt_question_blocks(text=text, page_number=16)
    assert len(blocks) == 1
    assert blocks[0].choices == ("1 12人のほか", "2 23人のなか", "3 34人のそば", "4 45人のため")


def test_parser_preserves_untyped_kana_paragraph_in_question() -> None:
    text = "48 問いの本文。\n\nよみ\n\n1 甲\n2 乙\n3 丙\n4 丁"
    blocks = parse_jlpt_question_blocks(text=text, page_number=16)
    assert len(blocks) == 1
    assert blocks[0].stem == "問いの本文。 よみ"


def test_parser_preserves_untyped_kana_with_crlf_and_space_only_blank_lines() -> None:
    text = "記事。\r\n \r\nキジ\r\n \r\n48 問い。\r\n1 甲\r\n2 乙\r\n3 丙\r\n4 丁\r\n \r\nよみ"
    blocks = parse_jlpt_question_blocks(text=text, page_number=16)
    assert len(blocks) == 1
    assert blocks[0].source_question_number == "48"
    assert blocks[0].choices[-1] == "4 丁 よみ"


def test_parser_preserves_decimal_in_last_choice() -> None:
    blocks = parse_jlpt_question_blocks(
        text="48 問い。\n1 甲\n2 乙\n3 丙\n4 全体の 1.5倍にする", page_number=16
    )
    assert blocks[0].choices[-1] == "4 全体の 1.5倍にする"


def test_parser_preserves_wrapped_quantity_in_choice() -> None:
    blocks = parse_jlpt_question_blocks(
        text="48 問い。\n1 来場者は\n16人です。\n2 乙\n3 丙\n4 丁", page_number=16
    )
    assert len(blocks) == 1
    assert blocks[0].choices[0] == "1 来場者は 16人です。"


def test_parser_preserves_ambiguous_terminal_number_equal_to_page() -> None:
    blocks = parse_jlpt_question_blocks(
        text="48 問い。\n1 甲\n2 乙\n3 丙\n4 人数は\n16", page_number=16
    )
    assert blocks[0].choices[-1] == "4 人数は 16"


def test_parser_preserves_untyped_kana_paragraphs_in_stem_and_choices() -> None:
    for position in ("stem", "c1", "c4"):
        parts = {"stem": "問い。", "c1": "第一", "c4": "第四"}
        parts[position] = "前半\n\nあいうえお\n\n後半"
        text = f"55 {parts['stem']}\n1 {parts['c1']}\n2 第二\n3 第三\n4 {parts['c4']}"

        blocks = parse_jlpt_question_blocks(text=text, page_number=16)

        assert len(blocks) == 1
        assert blocks[0].stem == " ".join(parts["stem"].split())
        assert blocks[0].choices[0] == "1 " + " ".join(parts["c1"].split())
        assert blocks[0].choices[-1] == "4 " + " ".join(parts["c4"].split())
        assert '"question_block_count": 1' in classify_exam_text(text).detail
