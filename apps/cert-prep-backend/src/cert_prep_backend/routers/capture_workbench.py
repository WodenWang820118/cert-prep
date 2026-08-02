"""Capture Workbench review-gated upload and confirmation API."""

from __future__ import annotations

import asyncio
import logging
from functools import partial
from pathlib import Path
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Header, HTTPException, Request, UploadFile, status
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from cert_prep_backend.api.dependencies import (
    get_database,
    get_capture_coordinator,
    get_document_worker_pool,
    get_settings,
    get_streaming_draft_generation_manager,
)
from cert_prep_backend.core.config import Settings
from cert_prep_backend.core.exceptions import BackendError, NotFoundError
from cert_prep_backend.domains.capture_workbench.contracts import (
    CaptureBlockV1,
    CaptureDocumentV1,
    CaptureEngineV1,
    CaptureJobStage,
    CaptureJobStatus,
    CaptureJobV1,
    CaptureReviewV1,
    CaptureSourceKind,
    RawCaptureSegmentV1,
    StructuringMode,
    reviewed_text_overrides,
)
from cert_prep_backend.domains.capture_workbench import review_sessions
from cert_prep_backend.domains.capture_workbench.coordinator import (
    CaptureRuntimeCanceledError,
    CaptureRuntimeJobError,
    CertPrepCaptureCoordinator,
)
from cert_prep_backend.domains.capture_workbench.review_workflow import (
    begin_review_capture,
    begin_review_confirmation,
    confirm_review_capture,
    cleanup_expired_review_sessions,
    review_digest,
)
from cert_prep_backend.domains.source_documents import operations
from cert_prep_backend.domains.projects import repository as projects_repository
from cert_prep_backend.domains.source_documents import repository as source_documents_repository
from cert_prep_backend.domains.source_documents.document_worker_pool import (
    DocumentWorkItem,
    DocumentWorkerPool,
)
from cert_prep_backend.domains.source_documents.source_preparation import (
    prepare_source,
)
from cert_prep_backend.domains.source_documents.storage import store_source_file
from cert_prep_backend.persistence.database import Database
from cert_prep_backend.api.errors import not_found_error
from cert_prep_backend.routers.documents import _read_limited_upload


router = APIRouter(
    prefix="/projects/{project_id}/capture-workbench/captures",
    tags=["capture-workbench"],
)
logger = logging.getLogger(__name__)
OperationIdHeader = Annotated[
    str | None,
    Header(alias="X-Cert-Prep-Operation-Id", min_length=1, max_length=128),
]


class CaptureReviewConfirmRequest(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )

    client_request_id: str = Field(min_length=1, max_length=128)
    review: CaptureReviewV1


class CaptureReviewJobRead(CaptureJobV1):
    """Host response that also lets the app map a capture to its document."""

    document_id: str


@router.post("", response_model=CaptureReviewJobRead, status_code=status.HTTP_202_ACCEPTED)
async def create_capture(
    request: Request,
    project_id: str,
    file: UploadFile = File(...),
    operation_id_header: OperationIdHeader = None,
    db: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
    workers: DocumentWorkerPool = Depends(get_document_worker_pool),
) -> CaptureReviewJobRead:
    coordinator = get_capture_coordinator(request)
    cleanup_expired_review_sessions(db, coordinator=coordinator)
    operation_id = operation_id_header or str(uuid4())
    try:
        projects_repository.ensure_project_exists(db, project_id)
    except NotFoundError as error:
        raise not_found_error(str(error)) from error
    claim = operations.claim_operation(
        db,
        project_id=project_id,
        operation_id=operation_id,
    )
    if not claim.acquired:
        raise HTTPException(status_code=409, detail="Document operation id is already in use.")
    session: dict | None = None
    try:
        content = await _read_limited_upload(file, settings.max_upload_bytes)
        prepared = await asyncio.to_thread(
            prepare_source,
            content,
            max_pdf_pages=settings.max_pdf_pages,
            max_image_pixels=settings.max_image_pixels,
            filename=file.filename,
        )
        if prepared.kind == "audio":
            raise HTTPException(
                status_code=422,
                detail="Capture review supports PDF and image sources only.",
            )
        sha256 = _sha256(content)
        storage_path = await asyncio.to_thread(
            store_source_file,
            settings,
            project_id,
            sha256,
            content,
            canonical_suffix=prepared.canonical_suffix,
        )
        document = operations.create_and_attach_document(
            db,
            project_id=project_id,
            operation_id=operation_id,
            filename=file.filename or f"{sha256}{prepared.canonical_suffix}",
            sha256=sha256,
            language_hint="auto",
            storage_path=str(storage_path),
            page_count=prepared.page_count,
        )
        session = review_sessions.create(
            db,
            project_id=project_id,
            document_id=document["id"],
            operation_id=operation_id,
        )
        item = DocumentWorkItem(
            operation_id=operation_id,
            run=partial(
                _run_begin,
                db=db,
                settings=settings,
                coordinator=coordinator,
                project_id=project_id,
                document_id=document["id"],
                operation_id=operation_id,
                session_id=session["id"],
                shutdown_requested=workers.is_closed,
            ),
            cancel_queued=partial(
                _cancel_queued,
                db,
                project_id=project_id,
                operation_id=operation_id,
                session_id=session["id"],
            ),
        )
        workers.submit(item)
    except Exception:
        try:
            operations.finish_failed(
                db,
                project_id=project_id,
                operation_id=operation_id,
                error="Capture review creation failed.",
            )
        except Exception:
            logger.exception(
                "Could not mark capture operation as failed", extra={"operation_id": operation_id}
            )
        if session is not None:
            try:
                review_sessions.finish(
                    db,
                    project_id=project_id,
                    session_id=session["id"],
                    status=review_sessions.FAILED,
                )
            except Exception:
                logger.exception(
                    "Could not mark capture review session as failed",
                    extra={"session_id": session["id"]},
                )
        raise
    return _job_from_document(session["id"], document, bytes_count=len(content))


@router.get("/{capture_id}", response_model=CaptureReviewJobRead)
def get_capture(
    request: Request,
    project_id: str,
    capture_id: str,
    db: Database = Depends(get_database),
) -> CaptureReviewJobRead:
    coordinator = get_capture_coordinator(request)
    cleanup_expired_review_sessions(db, coordinator=coordinator)
    session = _session_or_404(db, project_id, capture_id)
    document = _document_or_404(db, project_id, session["document_id"])
    runtime_id = session.get("runtime_capture_id")
    if runtime_id and session["status"] in review_sessions.ACTIVE:
        try:
            job = coordinator.get_capture(runtime_id)
        except Exception as error:
            raise HTTPException(
                status_code=502, detail="Capture Runtime status unavailable."
            ) from error
        return _host_job(
            job,
            capture_id=capture_id,
            document_id=session["document_id"],
        )
    if session["status"] == review_sessions.COMPLETED:
        return _job(
            capture_id,
            CaptureJobStatus.COMPLETED,
            CaptureJobStage.COMPLETED,
            document,
            progress=1,
            bytes_count=_document_bytes(db, project_id, document["id"]),
            document_id=document["id"],
        )
    if session["status"] == review_sessions.CANCELED:
        return _job(
            capture_id,
            CaptureJobStatus.CANCELLED,
            CaptureJobStage.CANCELLED,
            document,
            bytes_count=_document_bytes(db, project_id, document["id"]),
            document_id=document["id"],
        )
    if session["status"] == review_sessions.FAILED:
        return _job(
            capture_id,
            CaptureJobStatus.FAILED,
            CaptureJobStage.FAILED,
            document,
            bytes_count=_document_bytes(db, project_id, document["id"]),
            document_id=document["id"],
        )
    return _job(
        capture_id,
        CaptureJobStatus.RUNNING,
        CaptureJobStage.EXTRACTING,
        document,
        progress=0.05,
        bytes_count=_document_bytes(db, project_id, document["id"]),
        document_id=document["id"],
    )


@router.get("/{capture_id}/raw")
def get_raw(
    request: Request,
    project_id: str,
    capture_id: str,
    db: Database = Depends(get_database),
) -> dict:
    coordinator = get_capture_coordinator(request)
    cleanup_expired_review_sessions(db, coordinator=coordinator)
    session = _session_or_404(db, project_id, capture_id)
    if session["status"] != review_sessions.PENDING:
        raise HTTPException(status_code=409, detail="OCR review is no longer available.")
    runtime_id = session.get("runtime_capture_id")
    if not runtime_id:
        raise HTTPException(status_code=409, detail="OCR extraction has not reached review state.")
    try:
        return coordinator.get_raw(runtime_id).model_dump(by_alias=True, mode="json")
    except Exception as error:
        raise HTTPException(
            status_code=502, detail="Capture Runtime raw extraction unavailable."
        ) from error


@router.post(
    "/{capture_id}/confirm",
    response_model=CaptureReviewJobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def confirm_capture(
    request: Request,
    project_id: str,
    capture_id: str,
    confirm_request: CaptureReviewConfirmRequest,
    db: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
    workers: DocumentWorkerPool = Depends(get_document_worker_pool),
    streaming_questions=Depends(get_streaming_draft_generation_manager),
) -> CaptureReviewJobRead:
    coordinator = get_capture_coordinator(request)
    cleanup_expired_review_sessions(db, coordinator=coordinator)
    session = _session_or_404(db, project_id, capture_id)
    if session["status"] == review_sessions.COMPLETED:
        stored_request_id = session.get("confirm_request_id")
        if stored_request_id and (
            stored_request_id != confirm_request.client_request_id
            or session.get("confirm_review_digest") != review_digest(confirm_request.review)
        ):
            raise HTTPException(
                status_code=409,
                detail="Capture review confirmation request does not match the completed request.",
            )
        return get_capture(request, project_id, capture_id, db)
    if session["status"] not in {review_sessions.PENDING, review_sessions.CONFIRMING}:
        raise HTTPException(status_code=409, detail="Capture review is no longer pending.")
    document = _document_or_404(db, project_id, session["document_id"])
    if session["status"] == review_sessions.PENDING:
        runtime_id = session.get("runtime_capture_id")
        if not runtime_id:
            raise HTTPException(
                status_code=409, detail="OCR extraction has not reached review state."
            )
        raw = coordinator.get_raw(runtime_id)
        try:
            reviewed_text_overrides(raw, confirm_request.review)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
    try:
        claim = begin_review_confirmation(
            db,
            project_id=project_id,
            document_id=session["document_id"],
            operation_id=session["operation_id"],
            session_id=capture_id,
            review=confirm_request.review,
            client_request_id=confirm_request.client_request_id,
        )
    except (BackendError, RuntimeError) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if not claim.acquired:
        return _job(
            capture_id,
            CaptureJobStatus.RUNNING,
            CaptureJobStage.STRUCTURING,
            document,
            progress=0.75,
            bytes_count=_document_bytes(db, project_id, document["id"]),
            document_id=document["id"],
        )
    item = DocumentWorkItem(
        operation_id=session["operation_id"],
        run=partial(
            _run_confirm,
            db=db,
            coordinator=coordinator,
            project_id=project_id,
            document_id=session["document_id"],
            operation_id=session["operation_id"],
            session_id=capture_id,
            review=confirm_request.review,
            streaming_questions=streaming_questions,
            shutdown_requested=workers.is_closed,
        ),
        cancel_queued=partial(
            _cancel_queued,
            db,
            project_id=project_id,
            operation_id=session["operation_id"],
            session_id=capture_id,
        ),
    )
    try:
        workers.submit(item)
    except Exception as error:
        operations.finish_failed(
            db,
            project_id=project_id,
            operation_id=session["operation_id"],
            error="Capture review confirmation could not be queued.",
        )
        review_sessions.finish(
            db,
            project_id=project_id,
            session_id=capture_id,
            status=review_sessions.FAILED,
        )
        raise HTTPException(
            status_code=503, detail="Capture review confirmation could not be queued."
        ) from error
    return _job(
        capture_id,
        CaptureJobStatus.RUNNING,
        CaptureJobStage.STRUCTURING,
        document,
        progress=0.75,
        document_id=document["id"],
        bytes_count=_document_bytes(db, project_id, document["id"]),
    )


@router.post("/{capture_id}/cancel", response_model=CaptureReviewJobRead)
def cancel_capture(
    request: Request,
    project_id: str,
    capture_id: str,
    db: Database = Depends(get_database),
) -> CaptureReviewJobRead:
    coordinator = get_capture_coordinator(request)
    cleanup_expired_review_sessions(db, coordinator=coordinator)
    session = _session_or_404(db, project_id, capture_id)
    if session["status"] not in review_sessions.ACTIVE:
        return get_capture(request, project_id, capture_id, db)
    document = _document_or_404(db, project_id, session["document_id"])
    try:
        operations.cancel_operation(
            db,
            project_id=project_id,
            operation_id=session["operation_id"],
        )
        runtime_id = session.get("runtime_capture_id")
        if runtime_id:
            coordinator.cancel(runtime_id)
        operations.acknowledge_cancellation(
            db,
            project_id=project_id,
            operation_id=session["operation_id"],
        )
        review_sessions.finish(
            db,
            project_id=project_id,
            session_id=capture_id,
            status=review_sessions.CANCELED,
        )
    except Exception as error:
        raise HTTPException(
            status_code=502, detail="Capture cancellation could not be confirmed."
        ) from error
    return _job(
        capture_id,
        CaptureJobStatus.CANCELLED,
        CaptureJobStage.CANCELLED,
        document,
        bytes_count=_document_bytes(db, project_id, document["id"]),
        document_id=document["id"],
    )


@router.get("/{capture_id}/result", response_model=CaptureDocumentV1)
def get_result(
    request: Request,
    project_id: str,
    capture_id: str,
    db: Database = Depends(get_database),
) -> CaptureDocumentV1:
    cleanup_expired_review_sessions(
        db,
        coordinator=get_capture_coordinator(request),
    )
    session = _session_or_404(db, project_id, capture_id)
    if session["status"] != review_sessions.COMPLETED:
        raise HTTPException(status_code=409, detail="Capture review is not complete.")
    document = _document_or_404(db, project_id, session["document_id"])
    chunks = source_documents_repository.list_chunks(db, project_id, session["document_id"])
    return _document_projection(db, project_id, document, chunks)


def _run_begin(
    *,
    db: Database,
    settings: Settings,
    coordinator: CertPrepCaptureCoordinator,
    project_id: str,
    document_id: str,
    operation_id: str,
    session_id: str,
    shutdown_requested,
) -> None:
    document = source_documents_repository.get_document(db, project_id, document_id)
    source_file = source_documents_repository.get_source_file(db, project_id, document_id)
    source_kind = _source_kind(document["filename"])
    try:
        begin_review_capture(
            db,
            coordinator=coordinator,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
            session_id=session_id,
            file_name=document["filename"],
            content=Path(source_file.storage_path).read_bytes(),
            media_type=_media_type(document["filename"]),
            source_kind=source_kind,
            should_cancel=lambda: (
                shutdown_requested() or not _operation_active(db, project_id, operation_id)
            ),
        )
    except CaptureRuntimeCanceledError:
        _finish_canceled(db, project_id, operation_id, session_id)
    except CaptureRuntimeJobError as error:
        _finish_begin_failure(
            db,
            project_id=project_id,
            operation_id=operation_id,
            session_id=session_id,
            error=(
                "This PDF requires WindowsML OCR, which is unavailable in the installed "
                "Capture Runtime."
                if source_kind is CaptureSourceKind.PDF
                and error.code == "requirement_unavailable"
                else "Capture Runtime extraction failed."
            ),
        )
    except Exception:
        _finish_begin_failure(
            db,
            project_id=project_id,
            operation_id=operation_id,
            session_id=session_id,
            error="Capture Runtime extraction failed.",
        )


def _finish_begin_failure(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
    session_id: str,
    error: str,
) -> None:
    review_sessions.finish(
        db, project_id=project_id, session_id=session_id, status=review_sessions.FAILED
    )
    operations.finish_failed(
        db,
        project_id=project_id,
        operation_id=operation_id,
        error=error,
    )


def _run_confirm(
    *,
    db: Database,
    coordinator: CertPrepCaptureCoordinator,
    project_id: str,
    document_id: str,
    operation_id: str,
    session_id: str,
    review: CaptureReviewV1,
    streaming_questions,
    shutdown_requested,
) -> None:
    try:
        document = confirm_review_capture(
            db,
            coordinator=coordinator,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
            session_id=session_id,
            review=review,
            should_cancel=lambda: (
                shutdown_requested() or not _operation_active(db, project_id, operation_id)
            ),
        )
        if document["chunks_count"] > 0:
            streaming_questions.enqueue_document(db, project_id=project_id, document_id=document_id)
    except CaptureRuntimeCanceledError:
        _finish_canceled(db, project_id, operation_id, session_id)


def _cancel_queued(db: Database, *, project_id: str, operation_id: str, session_id: str) -> None:
    try:
        operations.cancel_operation(db, project_id=project_id, operation_id=operation_id)
        operations.acknowledge_cancellation(db, project_id=project_id, operation_id=operation_id)
    finally:
        try:
            review_sessions.finish(
                db, project_id=project_id, session_id=session_id, status=review_sessions.CANCELED
            )
        except Exception:
            pass


def _finish_canceled(db: Database, project_id: str, operation_id: str, session_id: str) -> None:
    try:
        operations.acknowledge_cancellation(db, project_id=project_id, operation_id=operation_id)
    finally:
        review_sessions.finish(
            db, project_id=project_id, session_id=session_id, status=review_sessions.CANCELED
        )


def _operation_active(db: Database, project_id: str, operation_id: str) -> bool:
    try:
        return (
            operations.get_operation(db, project_id=project_id, operation_id=operation_id)["status"]
            == "running"
        )
    except Exception:
        return False


def _session_or_404(db: Database, project_id: str, capture_id: str) -> dict:
    try:
        return review_sessions.get(db, project_id=project_id, session_id=capture_id)
    except NotFoundError as error:
        raise not_found_error(str(error)) from error


def _document_or_404(db: Database, project_id: str, document_id: str) -> dict:
    try:
        return source_documents_repository.get_document(db, project_id, document_id)
    except NotFoundError as error:
        raise not_found_error(str(error)) from error


def _coordinator_or_503() -> CertPrepCaptureCoordinator:
    raise AssertionError("Use the request-scoped Capture Runtime coordinator dependency.")


def _job_from_document(
    capture_id: str,
    document: dict,
    *,
    bytes_count: int,
) -> CaptureReviewJobRead:
    return _job(
        capture_id,
        CaptureJobStatus.QUEUED,
        CaptureJobStage.QUEUED,
        document,
        progress=0,
        bytes_count=bytes_count,
        document_id=document["id"],
    )


def _job(
    capture_id: str,
    status_value: CaptureJobStatus,
    stage: CaptureJobStage,
    document: dict,
    *,
    progress: float = 0,
    bytes_count: int | None = None,
    document_id: str | None = None,
) -> CaptureReviewJobRead:
    if bytes_count is None:
        raise ValueError("Capture response requires the stored source byte count.")
    return CaptureReviewJobRead(
        capture_id=capture_id,
        status=status_value,
        stage=stage,
        structuring_mode=StructuringMode.HOST,
        progress=progress,
        source={
            "sha256": document["sha256"],
            "fileName": document["filename"],
            "mediaType": _media_type(document["filename"]),
            "bytes": max(1, bytes_count),
        },
        error=None,
        created_at=document["created_at"],
        updated_at=document["updated_at"],
        completed_at=document["updated_at"]
        if status_value
        in {CaptureJobStatus.COMPLETED, CaptureJobStatus.FAILED, CaptureJobStatus.CANCELLED}
        else None,
        document_id=document_id or document["id"],
    )


def _host_job(
    job: CaptureJobV1,
    *,
    capture_id: str,
    document_id: str,
) -> CaptureReviewJobRead:
    return CaptureReviewJobRead.model_validate(
        {
            **job.model_dump(by_alias=True, mode="json"),
            "captureId": capture_id,
            "documentId": document_id,
        }
    )


def _document_projection(
    db: Database,
    project_id: str,
    document: dict,
    chunks: list[dict],
) -> CaptureDocumentV1:
    segments = [
        RawCaptureSegmentV1(
            segment_id=chunk["id"],
            order=index,
            locator={"kind": "page", "page": max(1, chunk["page_number"])},
            text=(chunk["raw_text"] or chunk["text"]).strip(),
        )
        for index, chunk in enumerate(chunks)
    ]
    blocks = [
        CaptureBlockV1(
            block_id=f"cert-prep-block-{segment.segment_id}",
            order=index,
            type="paragraph",
            source_segment_id=segment.segment_id,
            locator=segment.locator,
            source_text=segment.text,
            target_text=chunks[index]["text"].strip(),
        )
        for index, segment in enumerate(segments)
    ]
    source = {
        "sha256": document["sha256"],
        "fileName": document["filename"],
        "mediaType": _media_type(document["filename"]),
        "bytes": max(1, _document_bytes(db, project_id, document["id"])),
    }
    digest = f"sha256:{document['sha256']}"
    extraction = CaptureEngineV1(
        engine=document["extraction_method"] or "windowsml-ocr",
        model="capture-runtime@0.3.8",
        digest=digest,
        device=document["ocr_device"],
    )
    structuring = CaptureEngineV1(
        engine="cert-prep-host-structuring",
        model="cert-prep-backend",
        digest=digest,
        device=None,
    )
    return CaptureDocumentV1(
        source=source,
        raw_segments=segments,
        blocks=blocks,
        source_text="\n".join(segment.text for segment in segments),
        target_text="\n".join(block.target_text for block in blocks),
        extraction_engine=extraction,
        structuring_engine=structuring,
        warnings=([document["ocr_fallback_reason"]] if document["ocr_fallback_reason"] else []),
        created_at=document["created_at"],
        completed_at=document["updated_at"],
    )


def _document_bytes(db: Database, project_id: str, document_id: str) -> int:
    try:
        source_file = source_documents_repository.get_source_file(db, project_id, document_id)
        return Path(source_file.storage_path).stat().st_size
    except (OSError, KeyError):
        return 1


def _source_kind(filename: str) -> CaptureSourceKind:
    return CaptureSourceKind.PDF if filename.lower().endswith(".pdf") else CaptureSourceKind.IMAGE


def _media_type(filename: str) -> str:
    return "application/pdf" if filename.lower().endswith(".pdf") else "image/png"


def _sha256(content: bytes) -> str:
    import hashlib

    return hashlib.sha256(content).hexdigest()


__all__ = ["router"]
