"""Admission rules for extracted questions, one test per rule and per reason.

Exam text below is invented; it only mimics the OCR shapes the rules handle.
"""

import pytest

from cert_prep_backend.authoring.domain.question_admission import (
    AdmissionRejection,
    ExtractedQuestion,
    MIN_STEM_GROUNDING,
    admit_extracted_question,
)

_PAGE = (
    "問題3 ＿＿の言葉に意味が最も近いものを、1・2・3・4から一つ選びなさい。\n"
    "14 あの兄弟はいつもお互いに張り合っている。\n"
    "1 競争して 2 応援して 3 無視して 4 尊重して"
)
_CHOICES = ("1 競争して", "2 応援して", "3 無視して", "4 尊重して")


def _admit(question: str, *, source: str = _PAGE, exam_page: bool = True, choices=_CHOICES):
    return admit_extracted_question(
        ExtractedQuestion(question=question, choices=choices, source_text=source, exam_page=exam_page)
    )


def test_a_quoted_stem_is_admitted_unchanged() -> None:
    admission = _admit("あの兄弟はいつもお互いに張り合っている。")

    assert admission.admitted
    assert admission.question == "あの兄弟はいつもお互いに張り合っている。"


def test_glued_choices_are_cut_and_the_clean_stem_is_admitted() -> None:
    admission = _admit("あの兄弟はいつもお互いに張り合っている。 競争して 2 応援して 3 無視して")

    assert admission.question == "あの兄弟はいつもお互いに張り合っている。"


def test_one_mentioned_choice_word_is_not_cut() -> None:
    source = _PAGE + "\n15 「競争して」に最も近い意味の言葉はどれか。"

    admission = _admit("「競争して」に最も近い意味の言葉はどれか。", source=source)

    assert admission.question == "「競争して」に最も近い意味の言葉はどれか。"


@pytest.mark.parametrize(
    ("question", "source", "reason"),
    [
        ("1 競争して 2 応援して 3 無視して 4 尊重して", _PAGE, AdmissionRejection.CHOICES_ONLY),
        ("＿＿の言葉に意味が最も近いものを、1・2・3・4から一つ選びなさい。", _PAGE,
         AdmissionRejection.SECTION_INSTRUCTION),
        ("次の文章を読んで、後の問いに答えとして最もよいものを選びなさい。", _PAGE,
         AdmissionRejection.SECTION_INSTRUCTION),
        ("競争して、", _PAGE, AdmissionRejection.STEM_IS_A_CHOICE),
        ("文中提到兄弟的關係。這是什麼意思？", _PAGE, AdmissionRejection.STEM_NOT_IN_SOURCE),
        ("問題1", "第三部分 聴解\n問題1\n1 会場を探す 2 料金を考える",
         AdmissionRejection.LISTENING_PAGE),
        ("問題1", "問題用紙に何も印刷されていません。まず話を聞いてください。",
         AdmissionRejection.LISTENING_PAGE),
    ],
)
def test_each_rule_names_its_rejection(question, source, reason) -> None:
    admission = _admit(question, source=source)

    assert not admission.admitted
    assert admission.rejection is reason
    assert admission.question is None


def test_a_quoted_request_is_not_a_section_instruction() -> None:
    source = "問題7\n15 「正しい答えを選んでください」と誰が言ったか。\n1 先生 2 生徒 3 親 4 友人"

    admission = _admit(
        "「正しい答えを選んでください」と誰が言ったか。",
        source=source,
        choices=("1 先生", "2 生徒", "3 親", "4 友人"),
    )

    assert admission.admitted


def test_grounding_applies_only_to_exam_pages() -> None:
    admission = _admit("この教材の要点はどれか。", source="会議の議事録です。", exam_page=False)

    assert admission.admitted


def test_the_listening_rule_runs_before_cleanup() -> None:
    # A listening page is rejected as such even when its stem is made only of choices.
    admission = _admit(
        "1 競争して 2 応援して 3 無視して",
        source="第三部分 聴解\n1 競争して 2 応援して 3 無視して",
    )

    assert admission.rejection is AdmissionRejection.LISTENING_PAGE


def test_the_grounding_threshold_is_a_majority_of_the_stem() -> None:
    assert 0.5 < MIN_STEM_GROUNDING < 1.0
