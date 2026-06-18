from exam_prep_backend.domains.exam_content import (
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
