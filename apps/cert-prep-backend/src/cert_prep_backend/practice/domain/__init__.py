"""Domain model of the Practice and Review context, one module per aggregate."""

from cert_prep_backend.practice.domain.attempt import PracticeAttempt, answer_matches_key
from cert_prep_backend.practice.domain.exceptions import (
    PracticeRuleViolation,
    PracticeSessionConflict,
)
from cert_prep_backend.practice.domain.session import (
    DOCUMENT_REQUIRED_FOR_FULL_DOCUMENT_MESSAGE,
    NO_PLAYABLE_QUESTIONS_MESSAGE,
    QUESTION_NOT_IN_SESSION_MESSAGE,
    SELECTED_ANSWER_NOT_AVAILABLE_MESSAGE,
    PracticeQuestion,
    PracticeSession,
    PracticeSessionMode,
    PracticeSessionStatus,
    QuestionDraftStatus,
    QuestionSelection,
    select_questions,
)
from cert_prep_backend.practice.domain.wrong_answer import (
    AnsweredQuestion,
    RepeatedMiss,
    WrongAnswer,
    WrongAnswerCluster,
    WrongAnswerSummary,
    current_wrong_answers,
    current_wrong_answers_in,
)

__all__ = [
    "DOCUMENT_REQUIRED_FOR_FULL_DOCUMENT_MESSAGE",
    "NO_PLAYABLE_QUESTIONS_MESSAGE",
    "QUESTION_NOT_IN_SESSION_MESSAGE",
    "SELECTED_ANSWER_NOT_AVAILABLE_MESSAGE",
    "AnsweredQuestion",
    "PracticeAttempt",
    "PracticeQuestion",
    "PracticeRuleViolation",
    "PracticeSession",
    "PracticeSessionConflict",
    "PracticeSessionMode",
    "PracticeSessionStatus",
    "QuestionDraftStatus",
    "QuestionSelection",
    "RepeatedMiss",
    "WrongAnswer",
    "WrongAnswerCluster",
    "WrongAnswerSummary",
    "answer_matches_key",
    "current_wrong_answers",
    "current_wrong_answers_in",
    "select_questions",
]
