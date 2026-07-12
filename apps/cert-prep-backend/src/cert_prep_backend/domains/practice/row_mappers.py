from __future__ import annotations

import json
from sqlite3 import Row

from cert_prep_backend.domains.practice.models import (
    PracticeAttempt,
    PracticeQuestion,
    PracticeSession,
)


def session_to_record(row: Row) -> dict:
    return practice_session_from_row(row).to_record()


def practice_session_from_row(row: Row) -> PracticeSession:
    return PracticeSession(
        id=row["id"],
        project_id=row["project_id"],
        question_ids=tuple(json.loads(row["question_ids_json"])),
        status=row["status"],
        mode=row["mode"],
        source_document_id=row["source_document_id"],
        requested_question_count=row["requested_question_count"],
        random_seed=row["random_seed"],
        created_at=row["created_at"],
        completed_at=row["completed_at"],
        abandoned_at=row["abandoned_at"],
    )


def attempt_to_record(row: Row) -> dict:
    return {
        "id": row["id"],
        "session_id": row["session_id"],
        "project_id": row["project_id"],
        "question_id": row["question_id"],
        "selected_answer": row["selected_answer"],
        "is_correct": bool(row["is_correct"]),
        "created_at": row["created_at"],
    }


def practice_question_from_row(row: Row) -> PracticeQuestion:
    return PracticeQuestion(
        id=row["id"],
        choices=tuple(json.loads(row["choices_json"])),
        correct_answer=row["answer"],
        question=row["question"],
        status=row["status"],
        rationale=row["rationale"],
        citation_page=row["citation_page"],
        source_excerpt=row["source_excerpt"],
        document_id=row["document_id"],
    )


def practice_attempt_from_wrong_answer_row(project_id: str, row: Row) -> PracticeAttempt:
    return PracticeAttempt(
        id=row["attempt_id"],
        session_id=row["session_id"],
        project_id=project_id,
        question_id=row["question_id"],
        selected_answer=row["selected_answer"],
        is_correct=bool(row["is_correct"]),
        created_at=row["created_at"],
    )


def practice_question_from_wrong_answer_row(row: Row) -> PracticeQuestion:
    return PracticeQuestion(
        id=row["question_id"],
        choices=tuple(json.loads(row["choices_json"])),
        correct_answer=row["correct_answer"],
        question=row["question"],
        rationale=row["rationale"],
        citation_page=row["citation_page"],
        source_excerpt=row["source_excerpt"],
        document_id=row["document_id"],
    )
