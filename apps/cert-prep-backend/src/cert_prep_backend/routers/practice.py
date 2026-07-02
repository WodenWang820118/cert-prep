from __future__ import annotations

from fastapi import APIRouter, Depends, status

from cert_prep_backend.api.dependencies import get_database, get_llm_provider
from cert_prep_backend.domains.mock_exams.ports import DraftGenerationProvider as LLMProvider
from cert_prep_backend.persistence.database import Database
from cert_prep_backend.domains.practice import explanations as practice_explanations
from cert_prep_backend.domains.practice import repository as practice_repository
from cert_prep_backend.domains.practice.schemas import (
    PracticeAttemptCreate,
    PracticeAttemptRead,
    PracticeSessionCreate,
    PracticeSessionRead,
    WrongAnswerExplanationRead,
    WrongAnswerList,
)
from cert_prep_backend.api.errors import NotFoundError, ValidationError, not_found_error, validation_error


router = APIRouter(prefix="/projects/{project_id}", tags=["practice"])


@router.post(
    "/practice-sessions",
    response_model=PracticeSessionRead,
    status_code=status.HTTP_201_CREATED,
)
def create_practice_session(
    project_id: str,
    payload: PracticeSessionCreate,
    db: Database = Depends(get_database),
) -> dict:
    try:
        return practice_repository.create_session(
            db,
            project_id,
            mode=payload.mode,
            document_id=payload.document_id,
            question_count=payload.question_count,
            random_seed=payload.random_seed,
        )
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    except ValidationError as exc:
        raise validation_error(str(exc)) from exc


@router.get("/practice-sessions/{session_id}", response_model=PracticeSessionRead)
def get_practice_session(
    project_id: str,
    session_id: str,
    db: Database = Depends(get_database),
) -> dict:
    try:
        return practice_repository.get_session(db, project_id, session_id)
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@router.post(
    "/practice-sessions/{session_id}/attempts",
    response_model=PracticeAttemptRead,
    status_code=status.HTTP_201_CREATED,
)
def record_practice_attempt(
    project_id: str,
    session_id: str,
    payload: PracticeAttemptCreate,
    db: Database = Depends(get_database),
) -> dict:
    try:
        return practice_repository.record_attempt(
            db,
            project_id=project_id,
            session_id=session_id,
            question_id=payload.question_id,
            selected_answer=payload.selected_answer,
        )
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    except ValidationError as exc:
        raise validation_error(str(exc)) from exc


@router.get("/wrong-answers", response_model=WrongAnswerList)
def list_wrong_answers(project_id: str, db: Database = Depends(get_database)) -> dict:
    try:
        return {"items": practice_repository.list_wrong_answers(db, project_id)}
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@router.post(
    "/wrong-answers/{attempt_id}/explanation",
    response_model=WrongAnswerExplanationRead,
)
def explain_wrong_answer(
    project_id: str,
    attempt_id: str,
    db: Database = Depends(get_database),
    llm_provider: LLMProvider = Depends(get_llm_provider),
) -> dict:
    try:
        wrong_answer = practice_repository.get_current_wrong_answer(db, project_id, attempt_id)
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    return practice_explanations.explain_wrong_answer(llm_provider, wrong_answer)
