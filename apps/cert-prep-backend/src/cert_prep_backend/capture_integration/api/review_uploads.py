"""Capture review upload: claim the operation, receive the file and queue extraction."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Annotated
from uuid import uuid4

from fastapi import (
    APIRouter,
    Depends,
    File,
    Header,
    HTTPException,
    Request,
    UploadFile,
    status,
)

from capture_runtime_client import CaptureStatus
from cert_prep_backend.platform.dependencies import get_settings
from cert_prep_backend.api.errors import not_found_error, validation_error
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.capture_integration.api.dependencies import (
    get_capture_background_work,
    get_capture_file_store,
    get_capture_operations,
    get_capture_review_events,
    get_capture_review_maintenance,
    get_capture_review_store,
    get_capture_review_workflow,
    get_capture_sources,
    require_capture_coordinator,
)
from cert_prep_backend.capture_integration.api.review_lifecycle import operation_from_source
from cert_prep_backend.capture_integration.api.schemas import CaptureReviewOperationRead
from cert_prep_backend.capture_integration.application import use_cases as capture_reviews
from cert_prep_backend.capture_integration.application.errors import CaptureAudioRejected
from cert_prep_backend.capture_integration.application.ports import (
    CaptureBackgroundWork,
    CaptureSources,
    CaptureFileStore,
    CaptureOperations,
    CaptureReviewEvents,
    CaptureReviewMaintenance,
    CaptureReviewStore,
    CaptureReviewWorkflow,
)
from cert_prep_backend.projects.application.ports import ProjectRepository
from cert_prep_backend.source_library.application import use_cases as source_library
from cert_prep_backend.source_library.application.errors import SourceTooLarge

OperationIdHeader = Annotated[
    str | None,
    Header(alias="X-Cert-Prep-Operation-Id", min_length=1, max_length=128),
]


def get_project_repository(request: Request) -> ProjectRepository:
    return request.app.state.project_repository


def register_upload(router: APIRouter) -> None:
    router.post(
        "",
        response_model=CaptureReviewOperationRead,
        status_code=status.HTTP_202_ACCEPTED,
    )(create_capture)


async def create_capture(
    request: Request,
    project_id: str,
    file: UploadFile = File(...),
    operation_id_header: OperationIdHeader = None,
    settings: Settings = Depends(get_settings),
    projects: ProjectRepository = Depends(get_project_repository),
    sources: CaptureSources = Depends(get_capture_sources),
    operations: CaptureOperations = Depends(get_capture_operations),
    files: CaptureFileStore = Depends(get_capture_file_store),
    sessions: CaptureReviewStore = Depends(get_capture_review_store),
    workflow: CaptureReviewWorkflow = Depends(get_capture_review_workflow),
    maintenance: CaptureReviewMaintenance = Depends(get_capture_review_maintenance),
    work: CaptureBackgroundWork = Depends(get_capture_background_work),
    events: CaptureReviewEvents = Depends(get_capture_review_events),
) -> CaptureReviewOperationRead:
    require_capture_coordinator(request)
    capture_reviews.expire_capture_reviews(maintenance)
    operation_id = operation_id_header or str(uuid4())
    try:
        claim = capture_reviews.claim_capture_upload(
            projects,
            operations,
            project_id=project_id,
            operation_id=operation_id,
        )
    except NotFoundError as error:
        raise not_found_error(str(error)) from error
    if not claim.acquired:
        raise HTTPException(status_code=409, detail="Document operation id is already in use.")
    try:
        content = await source_library.receive_upload(file, settings.max_page_source_upload_bytes)
    except Exception as error:
        capture_reviews.abandon_capture_upload(
            sessions,
            operations,
            events,
            project_id=project_id,
            operation_id=operation_id,
            session_id=None,
        )
        if isinstance(error, SourceTooLarge):
            raise validation_error(str(error)) from error
        raise
    try:
        started = await asyncio.to_thread(
            capture_reviews.start_capture_review,
            sessions,
            sources,
            operations,
            files,
            workflow,
            work,
            events,
            project_id=project_id,
            operation_id=operation_id,
            filename=file.filename,
            content=content,
            max_pdf_pages=settings.max_pdf_pages,
            max_image_pixels=settings.max_image_pixels,
        )
    except CaptureAudioRejected as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return operation_from_source(
        started.session.id,
        started.source,
        status_value=CaptureStatus.WAITING_INPUT,
        progress=0,
        bytes_count=started.content_length,
        media_type=_media_type(started.source.filename, started.canonical_suffix),
    )


def _media_type(filename: str, canonical_suffix: str | None = None) -> str:
    suffix = (canonical_suffix or Path(filename).suffix).lower()
    return {
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
    }.get(suffix, "application/octet-stream")
