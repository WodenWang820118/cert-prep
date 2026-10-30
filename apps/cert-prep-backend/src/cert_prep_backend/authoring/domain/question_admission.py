"""When a question extracted from a source page may be shown to a learner.

LLM extraction (the reasoning path) reads OCR text of exam pages and returns items
that look like questions but are often unusable. Each rule below exists because of a
failure measured on OCR'd JLPT N1 booklets with qwen3.5:9b (see
docs/domain/authoring.md, "題目收錄規則"):

* the model copies the choices onto the end of the stem;
* it uses a section instruction ("次の文章を読んで…選びなさい") as the stem;
* it repeats a choice as the stem when a page has only fragments;
* it rewrites or translates the stem, so the question is no longer the exam's;
* it builds items from printed listening pages, which only work with the audio.

The rules run in a fixed order and stop at the first rejection, so every rejected item
has exactly one reason. Structural checks of the model's JSON (missing fields,
unresolvable pages, ungrounded excerpts) live with the response parser in
infrastructure but report their reasons with the same vocabulary.

To add a rule: add an ``AdmissionRejection`` value, a small predicate here, one line
in ``admit_extracted_question``, tests in tests/unit/authoring/test_question_admission.py,
and a row in the docs table. Measure the effect on recorded drafts before and after.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from difflib import SequenceMatcher
from enum import StrEnum
import re
import unicodedata


class AdmissionRejection(StrEnum):
    """Why an extracted item was not admitted. Internal: logged and measured, not in the API."""

    # Structural checks of the model's JSON, applied by the response parser.
    INCOMPLETE_ITEM = "incomplete_item"
    INVALID_CONFIDENCE = "invalid_confidence"
    UNRESOLVED_SOURCE = "unresolved_source"
    ANSWER_NOT_IN_CHOICES = "answer_not_in_choices"
    EXCERPT_NOT_IN_SOURCE = "excerpt_not_in_source"
    NOT_AN_EXAM_ITEM = "not_an_exam_item"
    # Content rules applied by admit_extracted_question.
    LISTENING_PAGE = "listening_page"
    CHOICES_ONLY = "choices_only"
    SECTION_INSTRUCTION = "section_instruction"
    STEM_IS_A_CHOICE = "stem_is_a_choice"
    STEM_NOT_IN_SOURCE = "stem_not_in_source"


@dataclass(frozen=True, slots=True)
class ExtractedQuestion:
    """An extracted stem and its choices, with the text of the page it came from."""

    question: str
    choices: tuple[str, ...]
    source_text: str
    exam_page: bool


@dataclass(frozen=True, slots=True)
class QuestionAdmission:
    """The decision on one extracted question: the cleaned stem, or the rejection reason."""

    question: str | None = None
    rejection: AdmissionRejection | None = None

    @property
    def admitted(self) -> bool:
        return self.rejection is None


# Share of the stem's characters that must appear in the page, counted in matching runs
# of at least three characters. OCR'd stems quote the page almost verbatim (measured
# above 0.9), while rewritten or translated stems fall far below this.
MIN_STEM_GROUNDING = 0.6

# A leading choice label: "1", "１", "A", "Ａ", optionally followed by "." "．" "、" ")" ":".
_CHOICE_LABEL = re.compile(r"^\s*(?:[0-9０-９]|[A-DＡ-Ｄa-d])\s*[.．、)）:：]?\s*")
# The label left behind when glued choices are cut, as in "…張り合っている。 1".
_TRAILING_CHOICE_LABEL = re.compile(r"\s*(?:[0-9０-９]|[A-DＡ-Ｄ])\s*[.．、)）]?\s*$")
# "1・2・3・4" appears only in section instructions ("1・2・3・4から一つ選びなさい").
_CHOICE_ENUMERATION = re.compile(r"[1１][・･][2２][・･][3３][・･][4４]")


def admit_extracted_question(candidate: ExtractedQuestion) -> QuestionAdmission:
    """Apply the content rules in order; the first failing rule names the rejection."""

    if _is_printed_listening_page(candidate.source_text):
        return QuestionAdmission(rejection=AdmissionRejection.LISTENING_PAGE)
    stem = _question_without_glued_choices(candidate.question, candidate.choices)
    if not stem:
        return QuestionAdmission(rejection=AdmissionRejection.CHOICES_ONLY)
    if _is_section_instruction(stem):
        return QuestionAdmission(rejection=AdmissionRejection.SECTION_INSTRUCTION)
    if _stem_is_a_choice(stem, candidate.choices):
        return QuestionAdmission(rejection=AdmissionRejection.STEM_IS_A_CHOICE)
    # Only exam pages are held to quoting: other study material has no printed stems.
    if candidate.exam_page and _grounded_share(stem, candidate.source_text) < MIN_STEM_GROUNDING:
        return QuestionAdmission(rejection=AdmissionRejection.STEM_NOT_IN_SOURCE)
    return QuestionAdmission(question=stem)


def _question_without_glued_choices(question: str, choices: Sequence[str]) -> str:
    """Cut the choices a model copied onto the end of the stem.

    Only a tail that holds at least two of the item's own choices is removed, so a stem
    that merely mentions one choice word ("「競争して」に最も近い…") stays intact.
    """
    bare = [text for text in (_CHOICE_LABEL.sub("", choice) for choice in choices) if len(text) >= 2]
    for start in sorted(index for text in bare if (index := question.find(text)) > 0):
        tail = question[start:]
        if sum(1 for text in bare if text in tail) >= 2:
            return _TRAILING_CHOICE_LABEL.sub("", question[:start]).strip()
    return question.strip()


def _is_section_instruction(stem: str) -> bool:
    """A section instruction is not a question.

    It either enumerates the choice numbers ("1・2・3・4から…") or opens with 次の and
    asks the reader to choose. A real stem may quote 「…選んでください」, so a bare
    request is not enough.
    """
    if _CHOICE_ENUMERATION.search(stem):
        return True
    return bool(re.match(r"\s*(?:問題\s*\S{0,3}\s*)?(?:次の|つぎの)", stem)) and bool(
        re.search(r"選びなさい|選んでください", stem)
    )


def _stem_is_a_choice(stem: str, choices: Sequence[str]) -> bool:
    """Text-grammar pages print only fragments, and the model then repeats a choice as the stem."""
    core = stem.strip().rstrip("、。,.　 ")
    return bool(core) and any(core in _CHOICE_LABEL.sub("", choice) for choice in choices)


def _is_printed_listening_page(source: str) -> bool:
    """Listening booklet pages print only choices; their items need the audio.

    Recognised by the section name (聴解, or 聽解 in Chinese-edited booklets) or by the
    printed listening instruction, which mentions the question sheet and listening.
    """
    return bool(re.search(r"聴解|聽解", source)) or ("問題用紙" in source and "聞いて" in source)


def _grounded_share(stem: str, source: str) -> float:
    """Share of the stem found in the source, ignoring whitespace and width differences."""

    def compact(text: str) -> str:
        return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text))

    stem_text, source_text = compact(stem), compact(source)
    if not stem_text:
        return 0.0
    blocks = SequenceMatcher(None, stem_text, source_text, autojunk=False).get_matching_blocks()
    return sum(block.size for block in blocks if block.size >= 3) / len(stem_text)
