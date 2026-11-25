from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from sqlite3 import Connection, Row
from uuid import uuid4

from cert_prep_backend.authoring.application.ports import (
    SourceQuestionCount,
    QuestionSources,
    StudyProjects,
)
from cert_prep_backend.authoring.domain.question import QuestionEdit, NewQuestion, Question
from cert_prep_backend.authoring.domain.models import QuestionSuggestion, UnavailableQuestionBlock
from cert_prep_backend.authoring.domain.generation import QuestionJobCanceledError
from cert_prep_backend.platform.database import Database, utc_now
from cert_prep_backend.platform.errors import NotFoundError

BindSourceQuestionCount = Callable[[Connection], SourceQuestionCount]
"""Source Library's question count and status of sources on the given connection, so it joins the commit."""


def create_question(
    db: Database,
    project_id: str,
    payload: NewQuestion,
    *,
    projects: StudyProjects,
    sources: QuestionSources,
    question_count: BindSourceQuestionCount,
) -> Question:
    if not projects.exists(project_id):
        raise NotFoundError("Project not found.")
    payload.ensure_source_is_complete()
    if payload.cites_a_source:
        assert payload.source_id is not None and payload.chunk_id is not None
        sources.chunk(project_id, payload.source_id, payload.chunk_id)
    question_id = str(uuid4())
    now = utc_now()
    with db.connect() as connection:
        # The inserted question and the source's question count commit together.
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            """
            INSERT INTO questions(
                id, project_id, source_id, chunk_id, question, choices_json,
                answer, answer_key_source, rationale, citation_page, source_excerpt,
                confidence, source_order, source_question_number, item_kind, group_key, group_prompt,
                created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                question_id,
                project_id,
                payload.source_id,
                payload.chunk_id,
                payload.question,
                json.dumps(list(payload.choices)),
                payload.answer,
                payload.answer_key_source,
                payload.rationale,
                payload.citation_page,
                payload.source_excerpt,
                payload.confidence,
                payload.source_order,
                payload.source_question_number,
                payload.item_kind,
                payload.group_key,
                payload.group_prompt,
                now,
                now,
            ),
        )
        if payload.source_id is not None:
            question_count(connection).record_authored_question_count(
                project_id,
                payload.source_id,
                _source_question_count(connection, project_id, payload.source_id),
            )
        row = _question_query(connection, project_id, question_id)
    if row is None:
        raise NotFoundError("Question not found.")
    return _question_from_row(row)


def create_generated_questions(
    db: Database,
    *,
    project_id: str,
    source_id: str,
    suggestions: list[QuestionSuggestion],
    projects: StudyProjects,
) -> list[Question]:
    if not projects.exists(project_id):
        raise NotFoundError("Project not found.")
    now = utc_now()
    question_ids: list[str] = []
    with db.connect() as connection:
        for index, suggestion in enumerate(suggestions, start=1):
            if _matching_generated_question_exists(
                connection,
                project_id=project_id,
                source_id=source_id,
                suggestion=suggestion,
            ):
                continue
            question_id = str(uuid4())
            question_ids.append(question_id)
            _insert_generated_question(
                connection,
                question_id=question_id,
                project_id=project_id,
                source_id=source_id,
                suggestion=suggestion,
                source_order=suggestion.source_order or index,
                now=now,
            )
        rows = [
            row
            for question_id in question_ids
            if (row := _question_query(connection, project_id, question_id)) is not None
        ]
    return [_question_from_row(row) for row in rows]


def append_generated_questions_and_complete_job(
    db: Database,
    *,
    job_id: str,
    project_id: str,
    source_id: str,
    suggestions: list[QuestionSuggestion],
    effective_provider: str | None,
    effective_model: str | None,
    fallback_reason: str | None,
    question_count: BindSourceQuestionCount,
    projects: StudyProjects,
) -> list[Question]:
    """Commit generated questions, the source's question count and status and the job's exact successful
    attribution atomically. The job ran after the source was imported, so Source Library
    records the import's question count."""

    if not projects.exists(project_id):
        raise NotFoundError("Project not found.")
    with db.connect() as connection:
        # The count and the source's status are read and written under one write lock, as
        # the single UPDATE that used to do both was.
        connection.execute("BEGIN IMMEDIATE")
        rows = _append_generated_questions(
            connection,
            project_id=project_id,
            source_id=source_id,
            suggestions=suggestions,
        )
        question_count(connection).record_import_question_count(
            project_id, source_id, _source_question_count(connection, project_id, source_id)
        )
        now = utc_now()
        updated_job = connection.execute(
            """
            UPDATE question_generation_jobs
            SET status = 'succeeded',
                phase = 'completed',
                cancellable = 0,
                generated_count = ?,
                last_error = NULL,
                effective_provider = ?,
                effective_model = ?,
                fallback_reason = ?,
                updated_at = ?
            WHERE id = ? AND project_id = ? AND source_id = ?
                AND status = 'running'
                AND phase = 'committing'
                AND cancellable = 0
            """,
            (
                len(rows),
                effective_provider,
                effective_model,
                fallback_reason,
                now,
                job_id,
                project_id,
                source_id,
            ),
        )
        if updated_job.rowcount != 1:
            job = connection.execute(
                """
                SELECT status
                FROM question_generation_jobs
                WHERE id = ? AND project_id = ? AND source_id = ?
                """,
                (job_id, project_id, source_id),
            ).fetchone()
            if job is not None and job["status"] in {"cancel_requested", "canceled"}:
                raise QuestionJobCanceledError("Question generation was canceled before commit.")
            raise NotFoundError(
                "Question generation job was not in its atomic commit phase."
            )
    return [_question_from_row(row) for row in rows]


def append_generated_questions_and_complete_manual_operation(
    db: Database,
    *,
    operation_id: str,
    project_id: str,
    source_id: str,
    suggestions: list[QuestionSuggestion],
    effective_provider: str | None,
    effective_model: str | None,
    fallback_reason: str | None,
    question_count: BindSourceQuestionCount,
    unavailable_blocks: Sequence[UnavailableQuestionBlock] = (),
    projects: StudyProjects,
) -> list[Question]:
    """Atomically publish manual questions, the source's question count and status and the operation's final
    attribution."""

    if not projects.exists(project_id):
        raise NotFoundError("Project not found.")
    with db.connect() as connection:
        # One write lock over the count and the source's status, as for a job commit.
        connection.execute("BEGIN IMMEDIATE")
        rows = _append_generated_questions(
            connection,
            project_id=project_id,
            source_id=source_id,
            suggestions=suggestions,
        )
        question_count(connection).record_question_count(
            project_id, source_id, _source_question_count(connection, project_id, source_id)
        )
        now = utc_now()
        updated = connection.execute(
            """
            UPDATE manual_question_generations
            SET status = 'succeeded', phase = 'completed', cancellable = 0,
                generated_count = ?, error = NULL,
                effective_provider = ?, effective_model = ?, fallback_reason = ?,
                unavailable_blocks_json = ?,
                updated_at = ?
            WHERE id = ? AND project_id = ? AND source_id = ?
              AND status = 'running' AND phase = 'committing' AND cancellable = 0
            """,
            (
                len(rows),
                effective_provider,
                effective_model,
                fallback_reason,
                json.dumps(
                    [block.to_serialized() for block in unavailable_blocks],
                    ensure_ascii=False,
                ),
                now,
                operation_id,
                project_id,
                source_id,
            ),
        )
        if updated.rowcount != 1:
            operation = connection.execute(
                """
                SELECT status
                FROM manual_question_generations
                WHERE id = ? AND project_id = ? AND source_id = ?
                """,
                (operation_id, project_id, source_id),
            ).fetchone()
            if operation is not None and operation["status"] in {
                "cancel_requested",
                "canceled",
            }:
                raise QuestionJobCanceledError(
                    "Manual question generation was canceled before commit."
                )
            raise NotFoundError(
                "Manual question generation was not in its atomic commit phase."
            )
    return [_question_from_row(row) for row in rows]


def _source_question_count(connection: Connection, project_id: str, source_id: str) -> int:
    """Every question of the source, which gives the source's question count."""

    return connection.execute(
        """
        SELECT COUNT(*)
        FROM questions
        WHERE project_id = ? AND source_id = ?
        """,
        (project_id, source_id),
    ).fetchone()[0]


def _insert_generated_question(
    connection,
    *,
    question_id: str,
    project_id: str,
    source_id: str,
    suggestion: QuestionSuggestion,
    source_order: int,
    now: str,
) -> None:
    connection.execute(
        """
        INSERT INTO questions(
            id, project_id, source_id, chunk_id, question, choices_json,
            answer, answer_key_source, rationale, citation_page, source_excerpt,
            confidence, source_order, source_question_number, item_kind, group_key, group_prompt,
            created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            question_id,
            project_id,
            source_id,
            suggestion.chunk_id,
            suggestion.question,
            json.dumps(suggestion.choices),
            suggestion.answer,
            suggestion.answer_key_source,
            suggestion.rationale,
            suggestion.citation_page,
            suggestion.source_excerpt,
            suggestion.confidence,
            source_order,
            suggestion.source_question_number,
            suggestion.item_kind.value,
            suggestion.group_key,
            suggestion.group_prompt,
            now,
            now,
        ),
    )


def _append_generated_questions(
    connection,
    *,
    project_id: str,
    source_id: str,
    suggestions: list[QuestionSuggestion],
) -> list[Row]:
    now = utc_now()
    question_ids: list[str] = []
    for index, suggestion in enumerate(suggestions, start=1):
        if _matching_generated_question_exists(
            connection,
            project_id=project_id,
            source_id=source_id,
            suggestion=suggestion,
        ):
            continue
        question_id = str(uuid4())
        question_ids.append(question_id)
        _insert_generated_question(
            connection,
            question_id=question_id,
            project_id=project_id,
            source_id=source_id,
            suggestion=suggestion,
            source_order=suggestion.source_order or index,
            now=now,
        )
    return [
        row
        for question_id in question_ids
        if (row := _question_query(connection, project_id, question_id)) is not None
    ]


def list_questions(
    db: Database,
    project_id: str,
    *,
    projects: StudyProjects,
) -> list[Question]:
    if not projects.exists(project_id):
        raise NotFoundError("Project not found.")
    with db.connect() as connection:
        rows = connection.execute(
            """
            SELECT *
            FROM questions
            WHERE project_id = ?
            ORDER BY created_at DESC
            """,
            (project_id,),
        ).fetchall()
    return [_question_from_row(row) for row in rows]


def update_question(
    db: Database, project_id: str, question_id: str, payload: QuestionEdit
) -> Question:
    edited = get_question(db, project_id, question_id).edited(payload, now=utc_now())
    with db.connect() as connection:
        connection.execute(
            """
            UPDATE questions
            SET question = ?, choices_json = ?, answer = ?, answer_key_source = ?, rationale = ?,
                citation_page = ?, source_excerpt = ?, confidence = ?, source_order = ?,
                source_question_number = ?, item_kind = ?, group_key = ?, group_prompt = ?,
                updated_at = ?
            WHERE project_id = ? AND id = ?
            """,
            (
                edited.question,
                json.dumps(list(edited.choices)),
                edited.answer,
                edited.answer_key_source,
                edited.rationale,
                edited.citation_page,
                edited.source_excerpt,
                edited.confidence,
                edited.source_order,
                edited.source_question_number,
                edited.item_kind,
                edited.group_key,
                edited.group_prompt,
                edited.updated_at,
                project_id,
                question_id,
            ),
        )
        row = _question_query(connection, project_id, question_id)
    if row is None:
        raise NotFoundError("Question not found.")
    return _question_from_row(row)


def get_question(db: Database, project_id: str, question_id: str) -> Question:
    with db.connect() as connection:
        row = _question_query(connection, project_id, question_id)
    if row is None:
        raise NotFoundError("Question not found.")
    return _question_from_row(row)


def _source_questions(
    connection: Connection, project_id: str, *, source_id: str | None
) -> list[Question]:
    """Questions in the order practice asks them.

    A project lists them by id. One source lists them in source order: a missing
    source order sorts after the ones that have it, then by page, creation and id.
    """

    if source_id is None:
        rows = connection.execute(
            """
            SELECT *
            FROM questions
            WHERE project_id = ?
            ORDER BY id
            """,
            (project_id,),
        ).fetchall()
    else:
        rows = connection.execute(
            """
            SELECT *
            FROM questions
            WHERE project_id = ? AND source_id = ?
            ORDER BY
                CASE WHEN source_order IS NULL THEN 1 ELSE 0 END,
                source_order,
                citation_page,
                created_at,
                id
            """,
            (project_id, source_id),
        ).fetchall()
    return [_question_from_row(row) for row in rows]


def _questions_for_ids(
    connection: Connection, project_id: str, question_ids: Sequence[str]
) -> list[Question]:
    ids = list(dict.fromkeys(question_ids))
    if not ids:
        return []
    placeholders = ", ".join("?" for _ in ids)
    rows = connection.execute(
        f"""
        SELECT *
        FROM questions
        WHERE project_id = ? AND id IN ({placeholders})
        """,
        (project_id, *ids),
    ).fetchall()
    return [_question_from_row(row) for row in rows]


def _question_query(connection, project_id: str, question_id: str) -> Row | None:
    return connection.execute(
        "SELECT * FROM questions WHERE project_id = ? AND id = ?",
        (project_id, question_id),
    ).fetchone()


def _matching_generated_question_exists(
    connection,
    *,
    project_id: str,
    source_id: str,
    suggestion: QuestionSuggestion,
) -> bool:
    if suggestion.source_question_number:
        row = connection.execute(
            """
            SELECT id
            FROM questions
            WHERE project_id = ?
              AND source_id = ?
              AND chunk_id = ?
              AND source_question_number = ?
            LIMIT 1
            """,
            (
                project_id,
                source_id,
                suggestion.chunk_id,
                suggestion.source_question_number,
            ),
        ).fetchone()
        if row is not None:
            return True

    row = connection.execute(
        """
        SELECT id
        FROM questions
        WHERE project_id = ?
          AND source_id = ?
          AND chunk_id = ?
          AND lower(trim(question)) = ?
        LIMIT 1
        """,
        (
            project_id,
            source_id,
            suggestion.chunk_id,
            suggestion.question.strip().casefold(),
        ),
    ).fetchone()
    return row is not None


def _question_from_row(row: Row) -> Question:
    return Question(
        id=row["id"],
        project_id=row["project_id"],
        source_id=row["source_id"],
        chunk_id=row["chunk_id"],
        question=row["question"],
        choices=tuple(json.loads(row["choices_json"])),
        answer=row["answer"],
        answer_key_source=row["answer_key_source"],
        rationale=row["rationale"],
        citation_page=row["citation_page"],
        citation_locator_kind=row["citation_locator_kind"],
        citation_start_ms=row["citation_start_ms"],
        citation_end_ms=row["citation_end_ms"],
        source_excerpt=row["source_excerpt"],
        confidence=row["confidence"],
        source_order=row["source_order"],
        source_question_number=row["source_question_number"],
        item_kind=row["item_kind"],
        group_key=row["group_key"],
        group_prompt=row["group_prompt"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


class SqliteQuestionRepository:
    """Questions stored in SQLite."""

    def __init__(
        self,
        db: Database,
        connection: Connection | None = None,
        *,
        projects: StudyProjects,
        sources: QuestionSources,
        question_count: BindSourceQuestionCount,
    ) -> None:
        # A caller's connection joins that transaction for reads. Practice passes the
        # connection of its unit of work; the write methods still open their own.
        self._db = db
        self._connection = connection
        self._projects = projects
        self._sources = sources
        self._question_count = question_count

    def questions_of(self, project_id: str) -> list[Question]:
        return list_questions(self._db, project_id, projects=self._projects)

    def write(self, project_id: str, authored_question: NewQuestion) -> Question:
        return create_question(
            self._db,
            project_id,
            authored_question,
            projects=self._projects,
            sources=self._sources,
            question_count=self._question_count,
        )

    def edit(self, project_id: str, question_id: str, edit: QuestionEdit) -> Question:
        if not self._projects.exists(project_id):
            raise NotFoundError("Project not found.")
        return update_question(self._db, project_id, question_id, edit)

    def add_generated(
        self, project_id: str, source_id: str, suggestions: Sequence[QuestionSuggestion]
    ) -> list[Question]:
        return create_generated_questions(
            self._db,
            project_id=project_id,
            source_id=source_id,
            suggestions=list(suggestions),
            projects=self._projects,
        )

    def count_for_source(self, project_id: str, source_id: str) -> int:
        if self._connection is not None:
            return _source_question_count(self._connection, project_id, source_id)
        with self._db.connect() as connection:
            return _source_question_count(connection, project_id, source_id)

    def for_source(self, project_id: str, *, source_id: str | None) -> list[Question]:
        if self._connection is not None:
            return _source_questions(self._connection, project_id, source_id=source_id)
        with self._db.connect() as connection:
            return _source_questions(connection, project_id, source_id=source_id)

    def find(self, project_id: str, question_id: str) -> Question | None:
        if self._connection is not None:
            row = _question_query(self._connection, project_id, question_id)
        else:
            with self._db.connect() as connection:
                row = _question_query(connection, project_id, question_id)
        return None if row is None else _question_from_row(row)

    def find_many(self, project_id: str, question_ids: Sequence[str]) -> list[Question]:
        if self._connection is not None:
            return _questions_for_ids(self._connection, project_id, question_ids)
        with self._db.connect() as connection:
            return _questions_for_ids(connection, project_id, question_ids)
