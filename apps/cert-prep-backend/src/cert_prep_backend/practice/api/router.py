from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status

from cert_prep_backend.api.dependencies import get_llm_provider
from cert_prep_backend.api.errors import (
    ApiErrorRead,
    api_error,
    not_found_error,
    validation_error,
)
from cert_prep_backend.ai_providers.domain.provider import LLMProvider
from cert_prep_backend.platform.database import utc_now
from cert_prep_backend.platform.errors import NotFoundError, ValidationError
from cert_prep_backend.practice.api.schemas import (
    PracticeAttemptCreate,
    PracticeAttemptRead,
    PracticeSessionCreate,
    PracticeSessionList,
    PracticeSessionQuestionRead,
    PracticeSessionRead,
    PracticeSessionSummaryRead,
    WrongAnswerClusterRead,
    WrongAnswerExplanationRead,
    WrongAnswerGroundedFields,
    WrongAnswerList,
    WrongAnswerRead,
    WrongAnswerRepeatedMissRead,
    WrongAnswerSummaryRead,
)
from cert_prep_backend.practice.application import use_cases
from cert_prep_backend.practice.application.explanations import WrongAnswerExplanation
from cert_prep_backend.practice.application.ports import PracticeStore
from cert_prep_backend.practice.application.use_cases import PracticeSessionDetails
from cert_prep_backend.practice.domain.attempt import PracticeAttempt
from cert_prep_backend.practice.domain.exceptions import PracticeSessionConflict
from cert_prep_backend.practice.domain.session import PracticeQuestion, PracticeSession
from cert_prep_backend.practice.domain.wrong_answer import WrongAnswer, WrongAnswerSummary


router = APIRouter(prefix="/projects/{project_id}", tags=["practice"])
PRACTICE_SESSION_CONFLICT_RESPONSES = {
    status.HTTP_409_CONFLICT: {
        "model": ApiErrorRead,
        "description": "The practice session state conflicts with the requested operation.",
    }
}


def get_practice_store(request: Request) -> PracticeStore:
    """The store create_app wires for this application."""

    return request.app.state.practice_store


@router.post(
    "/practice-sessions",
    response_model=PracticeSessionRead,
    status_code=status.HTTP_201_CREATED,
    responses=PRACTICE_SESSION_CONFLICT_RESPONSES,
)
def create_practice_session(
    project_id: str,
    payload: PracticeSessionCreate,
    store: PracticeStore = Depends(get_practice_store),
) -> PracticeSessionRead:
    try:
        details = use_cases.start_practice(
            store,
            project_id,
            mode=payload.mode,
            document_id=payload.document_id,
            question_count=payload.question_count,
            random_seed=payload.random_seed,
            wrong_attempt_ids=payload.wrong_attempt_ids,
            now=utc_now(),
        )
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    except ValidationError as exc:
        raise validation_error(str(exc)) from exc
    except PracticeSessionConflict as exc:
        raise _practice_session_conflict_error(exc) from exc
    return _session_read(details)


@router.get("/practice-sessions", response_model=PracticeSessionList)
def list_active_practice_sessions(
    project_id: str,
    store: PracticeStore = Depends(get_practice_store),
) -> PracticeSessionList:
    try:
        sessions = use_cases.list_active_practice(store, project_id)
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    return PracticeSessionList(items=[_summary_read(session) for session in sessions])


@router.get("/practice-sessions/{session_id}", response_model=PracticeSessionRead)
def get_practice_session(
    project_id: str,
    session_id: str,
    store: PracticeStore = Depends(get_practice_store),
) -> PracticeSessionRead:
    try:
        return _session_read(use_cases.view_practice(store, project_id, session_id))
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@router.post(
    "/practice-sessions/{session_id}/abandon",
    response_model=PracticeSessionRead,
    responses=PRACTICE_SESSION_CONFLICT_RESPONSES,
)
def abandon_practice_session(
    project_id: str,
    session_id: str,
    store: PracticeStore = Depends(get_practice_store),
) -> PracticeSessionRead:
    try:
        details = use_cases.abandon_practice(store, project_id, session_id, now=utc_now())
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    except PracticeSessionConflict as exc:
        raise _practice_session_conflict_error(exc) from exc
    return _session_read(details)


@router.post(
    "/practice-sessions/{session_id}/attempts",
    response_model=PracticeAttemptRead,
    status_code=status.HTTP_201_CREATED,
    responses=PRACTICE_SESSION_CONFLICT_RESPONSES,
)
def record_practice_attempt(
    project_id: str,
    session_id: str,
    payload: PracticeAttemptCreate,
    store: PracticeStore = Depends(get_practice_store),
) -> PracticeAttemptRead:
    try:
        attempt = use_cases.answer_question(
            store,
            project_id,
            session_id,
            question_id=payload.question_id,
            selected_answer=payload.selected_answer,
            now=utc_now(),
        )
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    except ValidationError as exc:
        raise validation_error(str(exc)) from exc
    except PracticeSessionConflict as exc:
        raise _practice_session_conflict_error(exc) from exc
    return _attempt_read(attempt)


@router.get("/wrong-answers", response_model=WrongAnswerList)
def list_wrong_answers(
    project_id: str,
    store: PracticeStore = Depends(get_practice_store),
) -> WrongAnswerList:
    try:
        wrong_answers = use_cases.list_wrong_answers(store, project_id)
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    return WrongAnswerList(items=[_wrong_answer_read(item) for item in wrong_answers])


@router.get("/wrong-answers/summary", response_model=WrongAnswerSummaryRead)
def summarize_wrong_answers(
    project_id: str,
    store: PracticeStore = Depends(get_practice_store),
) -> WrongAnswerSummaryRead:
    try:
        summary = use_cases.review_wrong_answers(store, project_id)
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    return _summary_of_wrong_answers(summary)


@router.post(
    "/wrong-answers/{attempt_id}/explanation",
    response_model=WrongAnswerExplanationRead,
)
def explain_wrong_answer(
    project_id: str,
    attempt_id: str,
    store: PracticeStore = Depends(get_practice_store),
    llm_provider: LLMProvider = Depends(get_llm_provider),
) -> WrongAnswerExplanationRead:
    try:
        explanation = use_cases.request_explanation(store, llm_provider, project_id, attempt_id)
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    return _explanation_read(explanation)


def _practice_session_conflict_error(exc: PracticeSessionConflict) -> HTTPException:
    details = (
        {"active_session": _summary_read(exc.active_session).model_dump(mode="json")}
        if exc.active_session is not None
        else None
    )
    return api_error(status.HTTP_409_CONFLICT, exc.code, exc.message, details)


def _summary_read(session: PracticeSession) -> PracticeSessionSummaryRead:
    return PracticeSessionSummaryRead(
        id=session.id,
        project_id=session.project_id,
        mode=session.mode,
        document_id=session.source_document_id,
        status=session.status,
        created_at=session.created_at,
    )


def _session_read(details: PracticeSessionDetails) -> PracticeSessionRead:
    session = details.session
    return PracticeSessionRead(
        id=session.id,
        project_id=session.project_id,
        question_ids=list(session.question_ids),
        questions=[_question_read(question) for question in session.questions],
        mode=session.mode,
        document_id=session.source_document_id,
        question_count=session.requested_question_count,
        random_seed=session.random_seed,
        status=session.status,
        created_at=session.created_at,
        completed_at=session.completed_at,
        abandoned_at=session.abandoned_at,
        attempts=[_attempt_read(attempt) for attempt in details.attempts],
    )


def _question_read(question: PracticeQuestion) -> PracticeSessionQuestionRead:
    return PracticeSessionQuestionRead(
        id=question.id,
        question=question.question,
        choices=list(question.choices),
        answer=question.correct_answer,
        rationale=question.rationale,
        citation_page=question.citation_page,
        source_excerpt=question.source_excerpt,
        document_id=question.document_id,
    )


def _attempt_read(attempt: PracticeAttempt) -> PracticeAttemptRead:
    return PracticeAttemptRead(
        id=attempt.id,
        session_id=attempt.session_id,
        project_id=attempt.project_id,
        question_id=attempt.question_id,
        selected_answer=attempt.selected_answer,
        is_correct=attempt.is_correct,
        created_at=attempt.created_at,
    )


def _wrong_answer_read(wrong_answer: WrongAnswer) -> WrongAnswerRead:
    return WrongAnswerRead(
        attempt_id=wrong_answer.attempt_id,
        session_id=wrong_answer.session_id,
        question_id=wrong_answer.question_id,
        question=wrong_answer.question,
        selected_answer=wrong_answer.selected_answer,
        correct_answer=wrong_answer.correct_answer,
        rationale=wrong_answer.rationale,
        citation_page=wrong_answer.citation_page,
        source_excerpt=wrong_answer.source_excerpt,
        document_id=wrong_answer.document_id,
        created_at=wrong_answer.created_at,
    )


def _summary_of_wrong_answers(summary: WrongAnswerSummary) -> WrongAnswerSummaryRead:
    return WrongAnswerSummaryRead(
        current_wrong_count=summary.current_wrong_count,
        cleared_count=summary.cleared_count,
        last_wrong_date=summary.last_wrong_date,
        repeated_misses=[
            WrongAnswerRepeatedMissRead(
                question_id=miss.question_id,
                question=miss.question,
                document_id=miss.document_id,
                citation_page=miss.citation_page,
                source_excerpt=miss.source_excerpt,
                miss_count=miss.miss_count,
                last_wrong_at=miss.last_wrong_at,
            )
            for miss in summary.repeated_misses
        ],
        clusters=[
            WrongAnswerClusterRead(
                document_id=cluster.document_id,
                citation_page=cluster.citation_page,
                current_wrong_count=cluster.current_wrong_count,
                cleared_count=cluster.cleared_count,
                last_wrong_at=cluster.last_wrong_at,
            )
            for cluster in summary.clusters
        ],
    )


def _explanation_read(explanation: WrongAnswerExplanation) -> WrongAnswerExplanationRead:
    fields = explanation.grounded_fields
    return WrongAnswerExplanationRead(
        attempt_id=explanation.attempt_id,
        explanation=explanation.explanation,
        provider=explanation.provider,
        model=explanation.model,
        grounded_fields=WrongAnswerGroundedFields(
            question=fields.question,
            selected_answer=fields.selected_answer,
            correct_answer=fields.correct_answer,
            rationale=fields.rationale,
            citation_page=fields.citation_page,
            source_excerpt=fields.source_excerpt,
        ),
        fallback=explanation.fallback,
    )
