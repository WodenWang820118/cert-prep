"""What the Practice and Review use cases need from storage and from other contexts."""

from __future__ import annotations

from collections.abc import Sequence
from contextlib import AbstractContextManager
from dataclasses import dataclass
from typing import Protocol

from cert_prep_backend.practice.domain.attempt import PracticeAttempt
from cert_prep_backend.practice.domain.session import PracticeQuestion, PracticeSession
from cert_prep_backend.practice.domain.wrong_answer import AnsweredQuestion


@dataclass(frozen=True, slots=True)
class DraftedQuestion:
    """A question draft as practice reads it. The owning context is Question Authoring.

    `status` is the draft's stored status. Queries that used to leave status out of the
    SELECT keep the practice question approved (`keep_status=False`).
    """

    id: str
    choices: tuple[str, ...]
    correct_answer: str | None
    question: str
    status: str
    rationale: str | None
    citation_page: int | None
    source_excerpt: str | None
    document_id: str | None
    answer_key_source: str | None

    def __post_init__(self) -> None:
        object.__setattr__(self, "choices", tuple(self.choices))

    def as_question(self, *, keep_status: bool) -> PracticeQuestion:
        return PracticeQuestion(
            id=self.id,
            choices=self.choices,
            correct_answer=self.correct_answer,
            question=self.question,
            status=self.status if keep_status else "approved",
            rationale=self.rationale,
            citation_page=self.citation_page,
            source_excerpt=self.source_excerpt,
            document_id=self.document_id,
            answer_key_source=self.answer_key_source,
        )


class StudyProjects(Protocol):
    """Whether a study project exists. Study Projects owns that fact."""

    def exists(self, project_id: str) -> bool: ...


class ProjectDocuments(Protocol):
    """Whether a source document belongs to a project. Source Library owns that fact."""

    def require(self, project_id: str, document_id: str) -> None:
        """NotFoundError unless the document belongs to the project."""
        ...


class PracticeQuestions(Protocol):
    """Question drafts practice reads, mapped out of Question Authoring."""

    def approved(
        self, project_id: str, *, document_id: str | None
    ) -> list[DraftedQuestion]:
        """Approved drafts of the project (by id), or of one document (in source order)."""
        ...

    def current(self, project_id: str, question_id: str) -> DraftedQuestion | None:
        """The project's current draft of one question, or None when it is gone."""
        ...

    def current_many(
        self, project_id: str, question_ids: Sequence[str]
    ) -> list[DraftedQuestion]:
        """The project's current drafts for these ids; ids with no draft are absent."""
        ...


class PracticeRepository(Protocol):
    """Practice data inside one unit of work."""

    def project_exists(self, project_id: str) -> bool: ...

    def active_session(self, project_id: str) -> PracticeSession | None:
        """The project's newest active session, without its questions."""
        ...

    def approved_questions(
        self, project_id: str, *, document_id: str | None
    ) -> list[PracticeQuestion]:
        """Approved questions of the project (by id), or of one document (in source order)."""
        ...

    def answer_history(self, project_id: str) -> list[AnsweredQuestion]:
        """Every attempt with its question as asked, newest first."""
        ...

    def answer_history_since(self, project_id: str, attempt_id: str) -> list[AnsweredQuestion]:
        """The latest attempts at the question of one attempt, from that attempt on."""
        ...

    def add_session(self, session: PracticeSession) -> None: ...

    def session(self, project_id: str, session_id: str) -> PracticeSession | None:
        """A session with its question snapshot."""
        ...

    def attempts_of(self, session: PracticeSession) -> list[PracticeAttempt]: ...

    def question_for_answer(
        self, session: PracticeSession, question_id: str
    ) -> PracticeQuestion | None:
        """The session's snapshot of a question, else the draft if it is playable."""
        ...

    def add_attempt(self, attempt: PracticeAttempt) -> None: ...

    def current_question(self, project_id: str, question_id: str) -> PracticeQuestion | None:
        """The project's current draft of a question, including its answer key."""
        ...

    def attempts_for_question(self, project_id: str, question_id: str) -> list[PracticeAttempt]:
        """Every stored attempt of one question, oldest first. The last one is the latest."""
        ...

    def save_attempt_grades(self, attempts: list[PracticeAttempt]) -> None:
        """Store is_correct for attempts whose grade changed."""
        ...

    def refresh_snapshot_keys(self, project_id: str, question: PracticeQuestion) -> int:
        """Copy the question's current key and rationale into the session snapshots that show
        the same question text and choices. Snapshots of an edited question keep what was shown."""
        ...

    def answered_question_ids(self, session: PracticeSession) -> set[str]: ...

    def save_status(self, session: PracticeSession) -> None:
        """Store a completed or abandoned session that was still active."""
        ...


class PracticeStore(Protocol):
    def writing(self) -> AbstractContextManager[PracticeRepository]:
        """A unit of work that holds the write lock until it ends."""
        ...

    def reading(self) -> AbstractContextManager[PracticeRepository]: ...

    def require_document(self, project_id: str, document_id: str) -> None:
        """NotFoundError unless the document belongs to the project."""
        ...
