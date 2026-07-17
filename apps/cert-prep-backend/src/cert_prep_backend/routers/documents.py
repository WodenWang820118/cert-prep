from __future__ import annotations

import asyncio
from pathlib import Path as FilePath
from threading import Thread
from typing import Annotated
from uuid import uuid4

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    Header,
    HTTPException,
    Path,
    Request,
    UploadFile,
    status,
)

from cert_prep_contracts.documents import DocumentOperationRead

from cert_prep_backend.core.config import Settings
from cert_prep_backend.core.exceptions import (
    DocumentOperationConflictError,
    DocumentOperationStateError,
    DocumentProcessingCanceledError,
    OperationNotCancellableError,
)
from cert_prep_backend.persistence.database import Database
from cert_prep_backend.api.dependencies import (
    get_database,
    get_document_ocr_provider_pool,
    get_llm_provider,
    get_settings,
    get_streaming_draft_generation_manager,
)
from cert_prep_backend.domains.mock_exams import repository as mock_exams_repository
from cert_prep_backend.domains.mock_exams.models import SourceChunk
from cert_prep_backend.domains.mock_exams.normalization import as_editable_question
from cert_prep_backend.domains.mock_exams.ports import DraftGenerationProvider as LLMProvider
from cert_prep_backend.domains.mock_exams.streaming import StreamingDraftGenerationManager
from cert_prep_backend.domains.projects import repository as projects_repository
from cert_prep_backend.domains.source_documents import operations as document_operations
from cert_prep_backend.domains.source_documents import repository as source_documents_repository
from cert_prep_backend.domains.source_documents.ocr_provider_pool import (
    DocumentOCRProviderPool,
)
from cert_prep_backend.domains.source_documents.pdf_extraction import (
    PdfExtractionProgress,
)
from cert_prep_backend.domains.source_documents.schemas import ChunkList, DocumentList, DocumentRead
from cert_prep_backend.domains.source_documents.source_preparation import (
    PreparedSource,
    extract_prepared_source,
    prepare_source,
)
from cert_prep_backend.domains.source_documents.storage import (
    sha256_hex,
    store_source_file,
)
from cert_prep_backend.api.errors import (
    ApiErrorRead,
    InvalidSourceError,
    NotFoundError,
    ProviderUnavailableError,
    api_error,
    not_found_error,
    validation_error,
)


router = APIRouter(prefix="/projects/{project_id}/documents", tags=["documents"])
operations_router = APIRouter(
    prefix="/projects/{project_id}/document-operations",
    tags=["document-operations"],
)
LANGUAGE_HINTS = {"auto", "ja", "zh-Hant", "zh-Hans", "en", "mixed"}
OPERATION_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$"
OperationIdHeader = Annotated[
    str | None,
    Header(
        alias="X-Cert-Prep-Operation-Id",
        min_length=1,
        max_length=128,
        pattern=OPERATION_ID_PATTERN,
    ),
]
OperationIdPath = Annotated[
    str,
    Path(min_length=1, max_length=128, pattern=OPERATION_ID_PATTERN),
]
NOT_FOUND_RESPONSE = {
    "model": ApiErrorRead,
    "description": "The project, document, or operation was not found.",
}
OPERATION_CONFLICT_RESPONSE = {
    "model": ApiErrorRead,
    "description": "The requested document operation transition was rejected.",
}
OCR_UNAVAILABLE_RESPONSE = {
    "model": ApiErrorRead,
    "description": "The configured OCR runtime is unavailable.",
}
VALIDATION_ERROR_RESPONSE = {
    "model": ApiErrorRead,
    "description": "Request validation failed.",
}


@operations_router.get(
    "/{operation_id}",
    response_model=DocumentOperationRead,
    responses={
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_ERROR_RESPONSE,
    },
)
def get_document_operation(
    project_id: str,
    operation_id: OperationIdPath,
    db: Database = Depends(get_database),
) -> dict:
    try:
        return document_operations.get_operation(
            db,
            project_id=project_id,
            operation_id=operation_id,
        )
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@operations_router.delete(
    "/{operation_id}",
    response_model=DocumentOperationRead,
    status_code=status.HTTP_202_ACCEPTED,
    responses={
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_409_CONFLICT: OPERATION_CONFLICT_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_ERROR_RESPONSE,
    },
)
def cancel_document_operation(
    project_id: str,
    operation_id: OperationIdPath,
    db: Database = Depends(get_database),
) -> dict:
    try:
        return document_operations.cancel_operation(
            db,
            project_id=project_id,
            operation_id=operation_id,
        )
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    except DocumentOperationConflictError as exc:
        raise _operation_conflict_error(str(exc)) from exc
    except OperationNotCancellableError as exc:
        raise _operation_not_cancellable_error(str(exc)) from exc
    except DocumentOperationStateError as exc:
        raise _operation_state_conflict_error(str(exc)) from exc


@router.get("", response_model=DocumentList)
def list_documents(
    project_id: str,
    db: Database = Depends(get_database),
) -> dict:
    try:
        return {"items": source_documents_repository.list_documents(db, project_id)}
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@router.post(
    "",
    response_model=DocumentRead,
    status_code=status.HTTP_201_CREATED,
    responses={
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_409_CONFLICT: OPERATION_CONFLICT_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_ERROR_RESPONSE,
        status.HTTP_503_SERVICE_UNAVAILABLE: OCR_UNAVAILABLE_RESPONSE,
    },
)
async def upload_document(
    request: Request,
    project_id: str,
    file: UploadFile = File(
        ...,
        description="A PDF, PNG, JPEG/JPG, or static WebP source file.",
    ),
    language_hint: str = Form(default="auto"),
    operation_id_header: OperationIdHeader = None,
    db: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
    llm_provider: LLMProvider = Depends(get_llm_provider),
    ocr_provider_pool: DocumentOCRProviderPool = Depends(get_document_ocr_provider_pool),
    streaming_questions: StreamingDraftGenerationManager = Depends(
        get_streaming_draft_generation_manager
    ),
) -> dict:
    operation_id = operation_id_header or str(uuid4())
    claimed = False
    try:
        projects_repository.ensure_project_exists(db, project_id)
        claim = document_operations.claim_operation(
            db,
            project_id=project_id,
            operation_id=operation_id,
        )
        if not claim.acquired:
            if claim.operation["status"] in {"cancel_requested", "canceled"}:
                raise _operation_canceled_error(
                    "Document upload was canceled before it started."
                )
            raise _operation_conflict_error(
                "Document operation id is already in use."
            )
        claimed = True
        content = await _read_limited_upload(file, settings.max_upload_bytes)
        prepared_source = await asyncio.to_thread(
            prepare_source,
            content,
            max_pdf_pages=settings.max_pdf_pages,
            max_image_pixels=settings.max_image_pixels,
        )
        try:
            await _prepare_document_ocr_provider_pool(ocr_provider_pool)
        except ProviderUnavailableError as exc:
            document_operations.finish_failed(
                db,
                project_id=project_id,
                operation_id=operation_id,
                error="OCR runtime is unavailable.",
            )
            raise api_error(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                code="paddle_runtime_missing",
                message=str(exc),
            ) from exc
        _ensure_upload_operation_queued(
            db,
            project_id=project_id,
            operation_id=operation_id,
        )
        sha256 = sha256_hex(content)
        storage_path = store_source_file(
            settings,
            project_id,
            sha256,
            content,
            canonical_suffix=prepared_source.canonical_suffix,
        )
        document = document_operations.create_and_attach_document(
            db,
            project_id=project_id,
            operation_id=operation_id,
            filename=file.filename or f"{sha256}{prepared_source.canonical_suffix}",
            sha256=sha256,
            language_hint=_normalized_language_hint(language_hint),
            storage_path=str(storage_path),
            page_count=prepared_source.page_count,
        )

        if bool(getattr(request.app.state, "document_processing_async_jobs", True)):
            _start_document_processing_worker(
                db=db,
                settings=settings,
                llm_provider=llm_provider,
                ocr_provider_pool=ocr_provider_pool,
                streaming_questions=streaming_questions,
                project_id=project_id,
                document_id=document["id"],
                operation_id=operation_id,
                source=prepared_source,
            )
            return document

        return _process_document_upload(
            db,
            settings,
            llm_provider,
            ocr_provider_pool,
            streaming_questions,
            project_id,
            document["id"],
            operation_id,
            prepared_source,
        )
    except HTTPException:
        if claimed:
            document_operations.finish_failed(
                db,
                project_id=project_id,
                operation_id=operation_id,
                error="Document upload did not pass validation.",
            )
        raise
    except InvalidSourceError as exc:
        if claimed:
            document_operations.finish_failed(
                db,
                project_id=project_id,
                operation_id=operation_id,
                error="Source validation failed.",
            )
        raise validation_error(str(exc)) from exc
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    except DocumentProcessingCanceledError as exc:
        raise _operation_canceled_error(str(exc)) from exc
    except DocumentOperationConflictError as exc:
        raise _operation_conflict_error(str(exc)) from exc
    except OperationNotCancellableError as exc:
        raise _operation_not_cancellable_error(str(exc)) from exc
    except DocumentOperationStateError as exc:
        raise _operation_state_conflict_error(str(exc)) from exc
    except Exception:
        if claimed:
            document_operations.finish_failed(
                db,
                project_id=project_id,
                operation_id=operation_id,
                error="Document upload failed.",
            )
        raise


@router.get("/{document_id}", response_model=DocumentRead)
def get_document(
    project_id: str,
    document_id: str,
    db: Database = Depends(get_database),
) -> dict:
    try:
        return source_documents_repository.get_document(db, project_id, document_id)
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@router.delete(
    "/{document_id}/processing",
    response_model=DocumentOperationRead,
    status_code=status.HTTP_202_ACCEPTED,
    responses={
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_409_CONFLICT: OPERATION_CONFLICT_RESPONSE,
    },
)
def cancel_document_processing(
    project_id: str,
    document_id: str,
    db: Database = Depends(get_database),
) -> dict:
    try:
        return document_operations.cancel_document_processing(
            db,
            project_id=project_id,
            document_id=document_id,
        )
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    except OperationNotCancellableError as exc:
        raise _operation_not_cancellable_error(str(exc)) from exc
    except DocumentOperationStateError as exc:
        raise _operation_state_conflict_error(str(exc)) from exc


@router.post(
    "/{document_id}/retry",
    response_model=DocumentOperationRead,
    status_code=status.HTTP_202_ACCEPTED,
    responses={
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_409_CONFLICT: OPERATION_CONFLICT_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_ERROR_RESPONSE,
        status.HTTP_503_SERVICE_UNAVAILABLE: OCR_UNAVAILABLE_RESPONSE,
    },
)
async def retry_document_processing(
    request: Request,
    project_id: str,
    document_id: str,
    operation_id_header: OperationIdHeader = None,
    db: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
    llm_provider: LLMProvider = Depends(get_llm_provider),
    ocr_provider_pool: DocumentOCRProviderPool = Depends(get_document_ocr_provider_pool),
    streaming_questions: StreamingDraftGenerationManager = Depends(
        get_streaming_draft_generation_manager
    ),
) -> dict:
    operation_id = operation_id_header or str(uuid4())
    try:
        source_file = source_documents_repository.get_source_file(
            db,
            project_id,
            document_id,
        )
        content = _read_stored_source_file(
            settings,
            project_id=project_id,
            storage_path=source_file.storage_path,
            expected_sha256=source_file.sha256,
        )
        prepared_source = await asyncio.to_thread(
            prepare_source,
            content,
            max_pdf_pages=settings.max_pdf_pages,
            max_image_pixels=settings.max_image_pixels,
        )
        await _prepare_document_ocr_provider_pool(ocr_provider_pool)
        operation = document_operations.start_retry_operation(
            db,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
        )
        if bool(getattr(request.app.state, "document_processing_async_jobs", True)):
            _start_document_processing_worker(
                db=db,
                settings=settings,
                llm_provider=llm_provider,
                ocr_provider_pool=ocr_provider_pool,
                streaming_questions=streaming_questions,
                project_id=project_id,
                document_id=document_id,
                operation_id=operation_id,
                source=prepared_source,
            )
            return operation

        _process_document_upload(
            db,
            settings,
            llm_provider,
            ocr_provider_pool,
            streaming_questions,
            project_id,
            document_id,
            operation_id,
            prepared_source,
        )
        return document_operations.get_operation(
            db,
            project_id=project_id,
            operation_id=operation_id,
        )
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    except InvalidSourceError as exc:
        raise _document_source_missing_error(
            "The stored source file is unavailable for retry."
        ) from exc
    except ProviderUnavailableError as exc:
        raise api_error(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="paddle_runtime_missing",
            message=str(exc),
        ) from exc
    except DocumentProcessingCanceledError as exc:
        raise _operation_canceled_error(str(exc)) from exc
    except DocumentOperationConflictError as exc:
        raise api_error(
            status_code=status.HTTP_409_CONFLICT,
            code="document_retry_conflict",
            message=str(exc),
        ) from exc
    except DocumentOperationStateError as exc:
        raise api_error(
            status_code=status.HTTP_409_CONFLICT,
            code="document_retry_not_allowed",
            message=str(exc),
        ) from exc


@router.get("/{document_id}/chunks", response_model=ChunkList)
def list_document_chunks(
    project_id: str,
    document_id: str,
    db: Database = Depends(get_database),
) -> dict:
    try:
        return {"items": source_documents_repository.list_chunks(db, project_id, document_id)}
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


async def _read_limited_upload(file: UploadFile, max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total_size = 0
    while chunk := await file.read(1024 * 1024):
        total_size += len(chunk)
        if total_size > max_bytes:
            raise validation_error(
                f"Source file is too large; the limit is {max_bytes} bytes."
            )
        chunks.append(chunk)
    return b"".join(chunks)


async def _prepare_document_ocr_provider_pool(
    ocr_provider_pool: DocumentOCRProviderPool,
) -> None:
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, ocr_provider_pool.prepare)


def _read_stored_source_file(
    settings: Settings,
    *,
    project_id: str,
    storage_path: str,
    expected_sha256: str,
) -> bytes:
    expected_root = (settings.data_dir / "uploads" / project_id).resolve()
    try:
        source_path = FilePath(storage_path).resolve(strict=True)
        source_path.relative_to(expected_root)
        stat = source_path.stat()
    except (OSError, ValueError) as exc:
        raise _document_source_missing_error(
            "The stored source file is unavailable for retry."
        ) from exc
    if not source_path.is_file() or stat.st_size <= 0 or stat.st_size > settings.max_upload_bytes:
        raise _document_source_missing_error(
            "The stored source file is unavailable for retry."
        )
    try:
        content = source_path.read_bytes()
    except OSError as exc:
        raise _document_source_missing_error(
            "The stored source file is unavailable for retry."
        ) from exc
    if sha256_hex(content) != expected_sha256:
        raise _document_source_missing_error(
            "The stored source file failed integrity verification."
        )
    return content


def _start_document_processing_worker(
    *,
    db: Database,
    settings: Settings,
    llm_provider: LLMProvider,
    ocr_provider_pool: DocumentOCRProviderPool,
    streaming_questions: StreamingDraftGenerationManager,
    project_id: str,
    document_id: str,
    operation_id: str,
    source: PreparedSource,
) -> None:
    worker = Thread(
        target=_process_document_upload,
        args=(
            db,
            settings,
            llm_provider,
            ocr_provider_pool,
            streaming_questions,
            project_id,
            document_id,
            operation_id,
            source,
        ),
        name=f"document-processing-{operation_id[:8]}",
        daemon=True,
    )
    try:
        worker.start()
    except Exception:
        document_operations.finish_failed(
            db,
            project_id=project_id,
            operation_id=operation_id,
            error="Document processing worker could not start.",
        )
        raise


def _auto_generate_exam_items(
    db: Database,
    *,
    provider: LLMProvider,
    project_id: str,
    document_id: str,
    limit: int,
) -> dict:
    chunks = [
        SourceChunk(
            id=chunk["id"],
            page_number=chunk["page_number"],
            chunk_index=chunk["chunk_index"],
            text=chunk["text"],
            raw_text=chunk["raw_text"],
            source_excerpt=chunk["source_excerpt"],
            line_start=chunk["line_start"],
            line_end=chunk["line_end"],
            line_count=chunk["line_count"],
            content_profile=chunk["content_profile"],
        )
        for chunk in source_documents_repository.get_source_chunks(db, project_id, document_id)
    ]
    try:
        suggestions = [
            as_editable_question(suggestion)
            for suggestion in provider.generate_drafts(chunks, limit)
        ]
    except ProviderUnavailableError:
        return _update_document_exam_state(db, project_id, document_id, 0)

    if not suggestions:
        return _update_document_exam_state(db, project_id, document_id, 0)

    drafts = mock_exams_repository.create_generated_drafts(
        db,
        project_id=project_id,
        document_id=document_id,
        suggestions=suggestions,
    )
    return _update_document_exam_state(db, project_id, document_id, len(drafts))


def _process_document_upload(
    db: Database,
    settings: Settings,
    llm_provider: LLMProvider,
    ocr_provider_pool: DocumentOCRProviderPool,
    streaming_questions: StreamingDraftGenerationManager,
    project_id: str,
    document_id: str,
    operation_id: str,
    source: PreparedSource,
) -> dict:
    def record_progress(progress: PdfExtractionProgress) -> None:
        source_documents_repository.record_extraction_progress(
            db,
            project_id=project_id,
            document_id=document_id,
            processed_page_count=progress.processed_page_count,
            page=progress.page,
            ocr_device=progress.ocr_device,
            ocr_fallback_reason=progress.ocr_fallback_reason,
            ocr_duration_ms=progress.ocr_duration_ms,
            parse_wall_duration_ms=progress.parse_wall_duration_ms,
            render_duration_ms=progress.render_duration_ms,
            ocr_engine_duration_ms=progress.ocr_engine_duration_ms,
            ocr_worker_count=progress.ocr_worker_count,
            first_chunk_ms=progress.first_chunk_ms,
            operation_id=operation_id,
        )

    try:
        _ensure_document_operation_running(
            db,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
        )
        with ocr_provider_pool.acquire() as ocr_provider:
            _ensure_document_operation_running(
                db,
                project_id=project_id,
                document_id=document_id,
                operation_id=operation_id,
            )
            extraction = extract_prepared_source(
                source,
                max_pdf_pages=settings.max_pdf_pages,
                max_page_text_chars=settings.max_page_text_chars,
                max_total_text_chars=settings.max_total_text_chars,
                ocr_provider=ocr_provider,
                ocr_render_scale=settings.ocr_render_scale,
                on_page_processed=record_progress,
            )
        document = document_operations.publish_success(
            db,
            project_id=project_id,
            operation_id=operation_id,
            document_id=document_id,
            extraction=extraction,
        )
        if document["chunks_count"] > 0:
            streaming_questions.enqueue_document(
                db,
                project_id=project_id,
                document_id=document_id,
            )
            document = source_documents_repository.get_document(
                db, project_id, document_id
            )
        if (
            settings.auto_generate_exam_on_upload
            and not settings.streaming_draft_generation_on_upload
            and document["chunks_count"] > 0
        ):
            document = _auto_generate_exam_items(
                db,
                provider=llm_provider,
                project_id=project_id,
                document_id=document_id,
                limit=settings.auto_generate_exam_limit,
            )
        return document
    except DocumentProcessingCanceledError:
        document_operations.acknowledge_cancellation(
            db,
            project_id=project_id,
            operation_id=operation_id,
        )
        return source_documents_repository.get_document(db, project_id, document_id)
    except (InvalidSourceError, ProviderUnavailableError) as exc:
        document_operations.finish_failed(
            db,
            project_id=project_id,
            operation_id=operation_id,
            error=str(exc),
        )
        return source_documents_repository.get_document(db, project_id, document_id)
    except Exception:
        document_operations.finish_failed(
            db,
            project_id=project_id,
            operation_id=operation_id,
            error="Document processing failed.",
        )
        return source_documents_repository.get_document(db, project_id, document_id)


def _ensure_document_operation_running(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
) -> None:
    operation = document_operations.get_operation(
        db,
        project_id=project_id,
        operation_id=operation_id,
    )
    if not (
        operation["document_id"] == document_id
        and operation["status"] == "running"
        and operation["phase"] == "processing"
        and operation["cancellable"]
    ):
        raise DocumentProcessingCanceledError(
            "Document processing is no longer active."
        )


def _ensure_upload_operation_queued(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
) -> None:
    operation = document_operations.get_operation(
        db,
        project_id=project_id,
        operation_id=operation_id,
    )
    if operation["status"] in {"cancel_requested", "canceled"}:
        raise DocumentProcessingCanceledError(
            "Document upload was canceled before it started."
        )
    if not (
        operation["document_id"] is None
        and operation["status"] == "queued"
        and operation["phase"] == "uploading"
        and operation["cancellable"]
    ):
        raise DocumentOperationStateError(
            "Document upload operation is no longer available."
        )


def _update_document_exam_state(
    db: Database,
    project_id: str,
    document_id: str,
    exam_item_count: int,
) -> dict:
    document = source_documents_repository.get_document(db, project_id, document_id)
    if document["status"] == "processing":
        next_status = "processing"
    elif document["has_text"] and document["chunks_count"] > 0:
        next_status = "ready"
    else:
        next_status = "exam_failed"
    return source_documents_repository.update_exam_state(
        db,
        project_id=project_id,
        document_id=document_id,
        status=next_status,
        exam_item_count=exam_item_count,
    )


def _normalized_language_hint(language_hint: str) -> str:
    return language_hint if language_hint in LANGUAGE_HINTS else "auto"


def _operation_canceled_error(message: str) -> HTTPException:
    return api_error(status.HTTP_409_CONFLICT, "operation_canceled", message)


def _operation_conflict_error(message: str) -> HTTPException:
    return api_error(status.HTTP_409_CONFLICT, "operation_conflict", message)


def _operation_not_cancellable_error(message: str) -> HTTPException:
    return api_error(status.HTTP_409_CONFLICT, "operation_not_cancellable", message)


def _operation_state_conflict_error(message: str) -> HTTPException:
    return api_error(status.HTTP_409_CONFLICT, "operation_state_conflict", message)


def _document_source_missing_error(message: str) -> HTTPException:
    return api_error(status.HTTP_409_CONFLICT, "document_source_missing", message)
