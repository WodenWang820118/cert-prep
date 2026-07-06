from __future__ import annotations

from cert_prep_backend.domains.practice.attempt_repository import (
    record_attempt as _record_attempt,
)
from cert_prep_backend.domains.practice.models import PracticeSessionMode, WrongAnswer
from cert_prep_backend.domains.practice.session_repository import (
    create_session as _create_session,
)
from cert_prep_backend.domains.practice.session_repository import (
    get_session as _get_session,
)
from cert_prep_backend.domains.practice.wrong_answer_repository import (
    get_current_wrong_answer as _get_current_wrong_answer,
)
from cert_prep_backend.domains.practice.wrong_answer_repository import (
    list_wrong_answers as _list_wrong_answers,
)
from cert_prep_backend.domains.practice.wrong_answer_repository import (
    summarize_wrong_answers as _summarize_wrong_answers,
)
from cert_prep_backend.persistence.database import Database


def create_session(
    db: Database,
    project_id: str,
    *,
    mode: PracticeSessionMode | str = PracticeSessionMode.RANDOM_DRAW,
    document_id: str | None = None,
    question_count: int | None = None,
    random_seed: int | None = None,
    wrong_attempt_ids: list[str] | None = None,
) -> dict:
    return _create_session(
        db,
        project_id,
        mode=mode,
        document_id=document_id,
        question_count=question_count,
        random_seed=random_seed,
        wrong_attempt_ids=wrong_attempt_ids,
    )


def get_session(db: Database, project_id: str, session_id: str) -> dict:
    return _get_session(db, project_id, session_id)


def record_attempt(
    db: Database,
    *,
    project_id: str,
    session_id: str,
    question_id: str,
    selected_answer: str,
) -> dict:
    return _record_attempt(
        db,
        project_id=project_id,
        session_id=session_id,
        question_id=question_id,
        selected_answer=selected_answer,
    )


def list_wrong_answers(db: Database, project_id: str) -> list[dict]:
    return _list_wrong_answers(db, project_id)


def get_current_wrong_answer(db: Database, project_id: str, attempt_id: str) -> WrongAnswer:
    return _get_current_wrong_answer(db, project_id, attempt_id)


def summarize_wrong_answers(db: Database, project_id: str) -> dict:
    return _summarize_wrong_answers(db, project_id)
