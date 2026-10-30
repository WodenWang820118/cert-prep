"""Synthetic model response shapes must retain strict draft validation."""

from dataclasses import replace

import pytest

from cert_prep_backend.authoring.domain.models import DraftSuggestion, SourceChunk
from cert_prep_backend.authoring.infrastructure.reasoning_parser import (
    draft_suggestion_from_item,
)


@pytest.fixture
def chunk() -> SourceChunk:
    return SourceChunk(
        id="chunk-8",
        page_number=8,
        text="Question: Select the second token. A. amber B. blue C. coral D. dusk",
    )


@pytest.fixture
def item() -> dict[str, object]:
    return {
        "question": "Question: Select the second token.",
        "choices": ["A. amber", "B. blue", "C. coral", "D. dusk"],
        "answer": "B",
        "answer_key_source": "ai_inferred",
        "rationale": "The second visible token is blue.",
        "citation_page": 8,
        "source_excerpt": "Question: Select the second token.",
        "confidence": "1.0",
    }


def _parse(item: dict[str, object], chunk: SourceChunk) -> DraftSuggestion | None:
    return draft_suggestion_from_item(item, {chunk.page_number: chunk}, {chunk.id: chunk})


@pytest.mark.parametrize("alias", ["question_stem", "stem"])
def test_question_alias_is_accepted_when_question_is_missing(item, chunk, alias) -> None:
    question = item.pop("question")
    item[alias] = question

    suggestion = _parse(item, chunk)

    assert suggestion is not None
    assert suggestion.question == question
    assert suggestion.confidence == 1.0


def test_question_takes_precedence_over_question_stem_and_stem(item, chunk) -> None:
    item.update(question_stem="An ignored alias.", stem="Another ignored alias.")

    suggestion = _parse(item, chunk)

    assert suggestion is not None
    assert suggestion.question == item["question"]


def test_question_stem_takes_precedence_over_stem(item, chunk) -> None:
    item["question_stem"] = item.pop("question")
    item["stem"] = "An ignored alias."

    suggestion = _parse(item, chunk)

    assert suggestion is not None
    assert suggestion.question == item["question_stem"]


@pytest.mark.parametrize("question", ["", None, 42])
def test_invalid_explicit_question_is_not_replaced_by_an_alias(item, chunk, question) -> None:
    item["question_stem"] = item["question"]
    item["question"] = question

    assert _parse(item, chunk) is None


@pytest.mark.parametrize("citation_page", ["page-8", "p.8", "8", 8])
@pytest.mark.parametrize("with_chunk_id", [False, True])
def test_citation_page_forms_resolve_the_source_chunk(
    item, chunk, citation_page, with_chunk_id
) -> None:
    item["citation_page"] = citation_page
    if with_chunk_id:
        item["chunk_id"] = chunk.id

    suggestion = _parse(item, chunk)

    assert suggestion is not None
    assert suggestion.chunk_id == chunk.id
    assert suggestion.citation_page == 8


@pytest.mark.parametrize("citation_page", ["page-9", "p.9", "9", 9])
@pytest.mark.parametrize("with_chunk_id", [False, True])
def test_unknown_or_conflicting_citation_pages_are_rejected(
    item, chunk, citation_page, with_chunk_id
) -> None:
    item["citation_page"] = citation_page
    if with_chunk_id:
        item["chunk_id"] = chunk.id

    assert _parse(item, chunk) is None


@pytest.mark.parametrize(
    "citation_page",
    [
        "page-8-9",
        "p.8/9",
        "8 or 9",
        "8.0",
        "page-8 extra",
        "chapter-8",
        True,
        False,
        [],
        {},
    ],
)
@pytest.mark.parametrize("with_chunk_id", [False, True])
def test_ambiguous_or_invalid_citation_pages_are_rejected(
    item, chunk, citation_page, with_chunk_id
) -> None:
    item["citation_page"] = citation_page
    if with_chunk_id:
        item["chunk_id"] = chunk.id

    assert _parse(item, chunk) is None


@pytest.mark.parametrize("citation_page", [None, ""])
def test_null_or_empty_citation_page_falls_back_to_the_chunk_id(item, chunk, citation_page) -> None:
    item["citation_page"] = citation_page
    item["chunk_id"] = chunk.id

    suggestion = _parse(item, chunk)

    assert suggestion is not None
    assert suggestion.citation_page == chunk.page_number


def test_integral_float_citation_page_resolves(item, chunk) -> None:
    item["citation_page"] = float(chunk.page_number)

    suggestion = _parse(item, chunk)

    assert suggestion is not None


def test_chunk_id_without_a_citation_page_still_resolves(item, chunk) -> None:
    item.pop("citation_page")
    item["chunk_id"] = chunk.id

    suggestion = _parse(item, chunk)

    assert suggestion is not None
    assert suggestion.citation_page == chunk.page_number


@pytest.mark.parametrize("labels", ["ABCD", "1234"])
@pytest.mark.parametrize(
    "answer,index", [("A", 0), ("B", 1), ("C", 2), ("D", 3), ("1", 0), ("2", 1), ("3", 2), ("4", 3)]
)
def test_letter_and_number_answers_select_the_labelled_choice(
    item, chunk, labels, answer, index
) -> None:
    choices = [
        f"{label}. {text}" for label, text in zip(labels, ["amber", "blue", "coral", "dusk"])
    ]
    item.update(choices=choices, answer=answer)

    suggestion = _parse(item, chunk)

    assert suggestion is not None
    assert suggestion.answer == choices[index]


@pytest.mark.parametrize("alias", ["question_stem", "stem"])
def test_alias_and_page_tolerance_still_reject_ungrounded_excerpts(item, chunk, alias) -> None:
    item[alias] = item.pop("question")
    item.update(citation_page="page-8", source_excerpt="This text is absent from the source.")

    assert _parse(item, chunk) is None


@pytest.mark.parametrize("answer", ["E", "5", "missing choice"])
def test_answer_must_still_match_a_visible_choice(item, chunk, answer) -> None:
    item["answer"] = answer

    assert _parse(item, chunk) is None


@pytest.mark.parametrize("confidence", [-0.1, 1.1, "NaN", "inf", True, None, "unknown"])
def test_invalid_confidence_is_still_rejected(item, chunk, confidence) -> None:
    item["confidence"] = confidence

    assert _parse(item, chunk) is None


def test_notice_text_is_still_rejected_with_a_question_alias(item, chunk) -> None:
    notice = "General instructions: choose a token."
    item.pop("question")
    item.update(question_stem=notice, citation_page="p.8", source_excerpt=notice)

    assert _parse(item, replace(chunk, text=notice)) is None


_EXAM_PAGE = (
    "問題3 ＿＿の言葉に意味が最も近いものを、1・2・3・4から一つ選びなさい。\n"
    "14 あの兄弟はいつもお互いに張り合っている。\n"
    "1 競争して 2 応援して 3 無視して 4 尊重して\n"
    "15 「正しい答えを選んでください」と誰が言ったか。\n"
    "1 先生 2 生徒 3 親 4 友人"
)


@pytest.fixture
def exam_chunk() -> SourceChunk:
    return SourceChunk(id="exam-3", page_number=3, text=_EXAM_PAGE)


def _exam_item(question: str, choices: list[str], answer: str) -> dict[str, object]:
    return {
        "question": question,
        "choices": choices,
        "answer": answer,
        "rationale": "本文の意味から判斷する。",
        "citation_page": 3,
        "source_excerpt": "あの兄弟はいつもお互いに張り合っている。",
        "confidence": 0.9,
    }


_CHOICES = ["1 競争して", "2 応援して", "3 無視して", "4 尊重して"]


def test_choices_glued_onto_the_stem_are_cut(exam_chunk) -> None:
    item = _exam_item("あの兄弟はいつもお互いに張り合っている。 競争して 2 応援して 3 無視して", _CHOICES, "1")

    suggestion = _parse(item, exam_chunk)

    assert suggestion is not None
    assert suggestion.question == "あの兄弟はいつもお互いに張り合っている。"


def test_a_stem_that_only_mentions_one_choice_is_kept(exam_chunk) -> None:
    chunk = replace(exam_chunk, text=_EXAM_PAGE + "\n16 「競争して」に最も近い意味の言葉はどれか。")
    item = _exam_item("「競争して」に最も近い意味の言葉はどれか。", _CHOICES, "1")

    suggestion = _parse(item, chunk)

    assert suggestion is not None
    assert suggestion.question == "「競争して」に最も近い意味の言葉はどれか。"


def test_a_stem_made_only_of_choices_is_rejected(exam_chunk) -> None:
    item = _exam_item("1 競争して 2 応援して 3 無視して 4 尊重して", _CHOICES, "1")

    assert _parse(item, exam_chunk) is None


@pytest.mark.parametrize(
    "stem",
    [
        "＿＿の言葉に意味が最も近いものを、1・2・3・4から一つ選びなさい。",
        "次の文章を読んで、後の問いに対する答えとして最もよいものを選びなさい。",
    ],
)
def test_section_instructions_are_not_questions(exam_chunk, stem) -> None:
    assert _parse(_exam_item(stem, _CHOICES, "1"), exam_chunk) is None


def test_a_quoted_request_inside_a_real_question_is_kept(exam_chunk) -> None:
    item = _exam_item(
        "「正しい答えを選んでください」と誰が言ったか。", ["1 先生", "2 生徒", "3 親", "4 友人"], "1"
    )

    assert _parse(item, exam_chunk) is not None


def test_a_stem_that_is_one_of_the_choices_is_rejected(exam_chunk) -> None:
    assert _parse(_exam_item("競争して、", _CHOICES, "1"), exam_chunk) is None


def test_a_rewritten_stem_that_the_page_does_not_contain_is_rejected(exam_chunk) -> None:
    item = _exam_item("文中提到兄弟的關係。這是什麼意思？", _CHOICES, "1")

    assert _parse(item, exam_chunk) is None


@pytest.mark.parametrize(
    "page",
    [
        "第三部分 聴解\n問題1\n1 新しい会場を探す 2 料金を考える",
        "問題用紙に何も印刷されていません。まず話を聞いてください。\n1 先生 2 生徒",
    ],
)
def test_items_from_printed_listening_pages_are_rejected(page) -> None:
    chunk = SourceChunk(id="listen-20", page_number=20, text=page)
    item = {
        "question": "問題1",
        "choices": ["1 新しい会場を探す", "2 料金を考える"],
        "answer": "1",
        "rationale": "聞いた内容による。",
        "citation_page": 20,
        "source_excerpt": "問題1",
        "confidence": 0.9,
    }

    assert _parse(item, chunk) is None
