from __future__ import annotations

from dataclasses import asdict

import asyncio
import logging
from collections.abc import Callable
from functools import partial
from pathlib import Path as FilePath
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Path, Request, Response, UploadFile, status
from fastapi.responses import FileResponse

from cert_prep_contracts.documents import DocumentOperationRead

from cert_prep_backend.api.dependencies import (
    get_capture_coordinator,
    get_document_worker_pool,
    get_llm_provider,
    get_streaming_draft_generation_manager,
)
from cert_prep_backend.platform.dependencies import (
    get_database,
    get_settings,
)
from cert_prep_backend.api.errors import (
    ApiErrorRead,
    api_error,
    not_found_error,
    validation_error,
)
from cert_prep_backend.platform.errors import (
    DocumentOperationConflictError,
    DocumentOperationStateError,
    DocumentProcessingCanceledError,
    InvalidSourceError,
    NotFoundError,
    OperationNotCancellableError,
    ProviderUnavailableError,
)
from cert_prep_backend.platform.config import Settings
from capture_runtime_client import CaptureSourceKind
from cert_prep_backend.capture_integration.infrastructure.coordinator import (
    CaptureRuntimeCanceledError,
    CaptureRuntimeJobError,
    CaptureRuntimeRequirementUnavailableError,
    CertPrepCaptureCoordinator,
    PDF_OCR_UNAVAILABLE_MESSAGE,
)
from cert_prep_backend.capture_integration.infrastructure.persistence import publish_capture_document
from cert_prep_backend.authoring.infrastructure import repository as mock_exams_repository
from cert_prep_backend.authoring.domain.models import source_chunk_from_document_chunk
from cert_prep_backend.authoring.domain.normalization import as_editable_question
from cert_prep_backend.authoring.domain.ports import DraftGenerationProvider as LLMProvider
from cert_prep_backend.authoring.infrastructure.streaming import StreamingDraftGenerationManager
from cert_prep_backend.projects.infrastructure import repository as projects_repository
from cert_prep_backend.source_library.application import use_cases as source_library
from cert_prep_backend.source_library.application.ports import (
    ChunkTranslator,
    DocumentOperationRepository,
    DocumentRepository,
    SourceFileStore,
)
from cert_prep_backend.source_library.domain.document import AUDIO_MEDIA_TYPES
from cert_prep_backend.source_library.domain.exceptions import SourceDocumentUnavailable
from cert_prep_backend.source_library.domain.operation import DocumentOperation
from cert_prep_backend.source_library.infrastructure import operations as document_operations
from cert_prep_backend.source_library.infrastructure import repository as source_documents_repository
from cert_prep_backend.platform.document_worker_pool import (
    DocumentWorkerPool,
    DocumentWorkItem,
)
from cert_prep_backend.source_library.api.markdown import (
    markdown_content_disposition,
    render_pdf_markdown,
)
from cert_prep_backend.source_library.api.schemas import (
    ChunkList,
    ChunkRead,
    ChunkUpdate,
    DocumentList,
    DocumentRead,
)
from cert_prep_backend.source_library.infrastructure.source_preparation import (
    PreparedSource,
    StoredSourceReference,
    prepare_source,
)
from cert_prep_backend.source_library.infrastructure.storage import (
    LocalSourceFileStore,
    sha256_hex,
    store_source_file,
)


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/projects/{project_id}/documents", tags=["documents"])
operations_router = APIRouter(
    prefix="/projects/{project_id}/document-operations",
    tags=["document-operations"],
)
LANGUAGE_HINTS = {"auto", "ja", "zh-Hant", "zh-Hans", "en", "mixed"}
OPERATION_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$"
OperationIdHeader = Annotated[
    str | None,
    Header(alias="X-Cert-Prep-Operation-Id", min_length=1, max_length=128, pattern=OPERATION_ID_PATTERN),
]
OperationIdPath = Annotated[
    str,
    Path(min_length=1, max_length=128, pattern=OPERATION_ID_PATTERN),
]
NOT_FOUND_RESPONSE = {"model": ApiErrorRead, "description": "The project, document, or operation was not found."}
OPERATION_CONFLICT_RESPONSE = {"model": ApiErrorRead, "description": "The requested document operation transition was rejected."}
CAPTURE_UNAVAILABLE_RESPONSE = {"model": ApiErrorRead, "description": "The configured Capture Runtime is unavailable."}
VALIDATION_ERROR_RESPONSE = {"model": ApiErrorRead, "description": "Request validation failed."}
AUDIO_SOURCE_CONTENT = {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}}
MARKDOWN_CONTENT = {"text/markdown": {"schema": {"type": "string", "format": "binary"}}}


def get_document_repository(request: Request) -> DocumentRepository:
    """The repositories, file store and translator create_app wires for this application."""

    return request.app.state.document_repository


def get_document_operation_repository(request: Request) -> DocumentOperationRepository:
    return request.app.state.document_operation_repository


def get_source_file_store(request: Request) -> SourceFileStore:
    return request.app.state.source_file_store


def get_chunk_translator(request: Request) -> ChunkTranslator:
    return request.app.state.chunk_translator


@operations_router.get(
    "/{operation_id}",
    response_model=DocumentOperationRead,
    responses={status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE, status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_ERROR_RESPONSE},
)
def get_document_operation(project_id: str, operation_id: OperationIdPath, operations: DocumentOperationRepository = Depends(get_document_operation_repository)) -> dict:
    try:
        return _operation_read(source_library.view_operation(operations, project_id, operation_id))
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@operations_router.delete(
    "/{operation_id}",
    response_model=DocumentOperationRead,
    status_code=status.HTTP_202_ACCEPTED,
    responses={status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE, status.HTTP_409_CONFLICT: OPERATION_CONFLICT_RESPONSE, status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_ERROR_RESPONSE},
)
def cancel_document_operation(
    project_id: str,
    operation_id: OperationIdPath,
    operations: DocumentOperationRepository = Depends(get_document_operation_repository),
    worker_pool: DocumentWorkerPool = Depends(get_document_worker_pool),
) -> dict:
    try:
        return _operation_read(source_library.cancel_operation(operations, worker_pool, project_id, operation_id))
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    except DocumentOperationConflictError as exc:
        raise _operation_conflict_error(str(exc)) from exc
    except OperationNotCancellableError as exc:
        raise _operation_not_cancellable_error(str(exc)) from exc
    except DocumentOperationStateError as exc:
        raise _operation_state_conflict_error(str(exc)) from exc


@router.get("", response_model=DocumentList)
def list_documents(project_id: str, documents: DocumentRepository = Depends(get_document_repository)) -> dict:
    try:
        return {"items": source_library.list_documents(documents, project_id)}
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
        status.HTTP_503_SERVICE_UNAVAILABLE: CAPTURE_UNAVAILABLE_RESPONSE,
    },
)
async def upload_document(
    request: Request,
    project_id: str,
    file: UploadFile = File(..., description="A PDF, PNG, JPEG/JPG, static WebP, MP3, WAV, or M4A source file."),
    language_hint: str = Form(default="auto"),
    operation_id_header: OperationIdHeader = None,
    db=Depends(get_database),
    settings: Settings = Depends(get_settings),
    llm_provider: LLMProvider = Depends(get_llm_provider),
    streaming_questions: StreamingDraftGenerationManager = Depends(get_streaming_draft_generation_manager),
    worker_pool: DocumentWorkerPool = Depends(get_document_worker_pool),
    capture_coordinator: CertPrepCaptureCoordinator = Depends(get_capture_coordinator),
) -> dict:
    operation_id = operation_id_header or str(uuid4())
    claimed = False
    try:
        projects_repository.ensure_project_exists(db, project_id)
        claim = document_operations.claim_operation(db, project_id=project_id, operation_id=operation_id)
        if not claim.acquired:
            if claim.operation.status in {"cancel_requested", "canceled"}:
                raise _operation_canceled_error("Document upload was canceled before it started.")
            raise _operation_conflict_error("Document operation id is already in use.")
        claimed = True
        is_audio_name = FilePath(file.filename or "").suffix.lower() in AUDIO_MEDIA_TYPES
        upload_limit = settings.max_audio_upload_bytes if is_audio_name else settings.max_upload_bytes
        content = await _read_limited_upload(file, upload_limit)
        prepared_source = await asyncio.to_thread(
            prepare_source,
            content,
            max_pdf_pages=settings.max_pdf_pages,
            max_image_pixels=settings.max_image_pixels,
            filename=file.filename,
        )
        _ensure_upload_operation_queued(db, project_id=project_id, operation_id=operation_id)
        sha256, storage_path = await asyncio.to_thread(
            _store_uploaded_source,
            settings,
            project_id=project_id,
            content=content,
            canonical_suffix=prepared_source.canonical_suffix,
        )
        _ensure_upload_operation_queued(db, project_id=project_id, operation_id=operation_id)
        document = document_operations.create_and_attach_document(
            db,
            project_id=project_id,
            operation_id=operation_id,
            filename=file.filename or f"{sha256}{prepared_source.canonical_suffix}",
            sha256=sha256,
            language_hint=_normalized_language_hint(language_hint),
            storage_path=str(storage_path),
            page_count=prepared_source.page_count,
            source_kind="audio" if prepared_source.kind == "audio" else "document",
            duration_ms=prepared_source.duration_ms,
        )
        async_processing = bool(getattr(request.app.state, "document_processing_async_jobs", True))
        if async_processing:
            source = StoredSourceReference(
                storage_path=str(storage_path),
                sha256=sha256,
                canonical_suffix=prepared_source.canonical_suffix,
                filename=document.filename,
                kind=prepared_source.kind,
            )
            _submit_document_processing(
                worker_pool=worker_pool,
                db=db,
                settings=settings,
                llm_provider=llm_provider,
                streaming_questions=streaming_questions,
                project_id=project_id,
                document_id=document.id,
                operation_id=operation_id,
                source=source,
                coordinator=capture_coordinator,
            )
            return source_documents_repository.get_document(db, project_id, document.id)
        return _process_document_upload(
            db=db,
            settings=settings,
            llm_provider=llm_provider,
            streaming_questions=streaming_questions,
            project_id=project_id,
            document_id=document.id,
            operation_id=operation_id,
            source=prepared_source,
            coordinator=capture_coordinator,
        )
    except HTTPException:
        if claimed:
            document_operations.finish_failed(db, project_id=project_id, operation_id=operation_id, error="Document upload did not pass validation.")
        raise
    except InvalidSourceError as exc:
        if claimed:
            document_operations.finish_failed(db, project_id=project_id, operation_id=operation_id, error="Source validation failed.")
        raise validation_error(str(exc)) from exc
    except ProviderUnavailableError as exc:
        if claimed:
            document_operations.finish_failed(db, project_id=project_id, operation_id=operation_id, error=str(exc))
        raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "capture_runtime_unavailable", str(exc)) from exc
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
            document_operations.finish_failed(db, project_id=project_id, operation_id=operation_id, error="Document upload failed.")
        raise


@router.get("/{document_id}", response_model=DocumentRead)
def get_document(project_id: str, document_id: str, documents: DocumentRepository = Depends(get_document_repository)) -> dict:
    try:
        return source_library.view_document(documents, project_id, document_id)
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@router.get("/{document_id}/markdown", response_class=Response, responses={status.HTTP_200_OK: {"description": "The authenticated Markdown projection of a ready PDF.", "content": MARKDOWN_CONTENT}, status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE, status.HTTP_409_CONFLICT: OPERATION_CONFLICT_RESPONSE})
def get_document_markdown(project_id: str, document_id: str, documents: DocumentRepository = Depends(get_document_repository)) -> Response:
    try:
        projection = source_library.export_markdown(documents, project_id, document_id)
        filename = projection.document.filename
        return Response(content=render_pdf_markdown(filename=filename, chunks=list(projection.chunks)), media_type="text/markdown", headers={"Cache-Control": "private, no-store", "Content-Disposition": markdown_content_disposition(filename)})
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    except SourceDocumentUnavailable as exc:
        raise api_error(status.HTTP_409_CONFLICT, exc.code, exc.message) from exc


@router.get("/{document_id}/source", response_class=FileResponse, responses={status.HTTP_200_OK: {"description": "The authenticated canonical audio source.", "content": AUDIO_SOURCE_CONTENT}, status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE, status.HTTP_409_CONFLICT: OPERATION_CONFLICT_RESPONSE})
def get_document_audio_source(project_id: str, document_id: str, documents: DocumentRepository = Depends(get_document_repository), files: SourceFileStore = Depends(get_source_file_store)) -> FileResponse:
    try:
        source = source_library.open_audio_source(documents, files, project_id, document_id)
        return FileResponse(source.path, media_type=source.media_type, filename=source.filename, content_disposition_type="inline", headers={"Cache-Control": "private, no-store"})
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    except SourceDocumentUnavailable as exc:
        raise api_error(status.HTTP_409_CONFLICT, exc.code, exc.message) from exc


@router.delete("/{document_id}/processing", response_model=DocumentOperationRead, status_code=status.HTTP_202_ACCEPTED, responses={status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE, status.HTTP_409_CONFLICT: OPERATION_CONFLICT_RESPONSE})
def cancel_document_processing(project_id: str, document_id: str, operations: DocumentOperationRepository = Depends(get_document_operation_repository), worker_pool: DocumentWorkerPool = Depends(get_document_worker_pool)) -> dict:
    try:
        return _operation_read(source_library.cancel_processing(operations, worker_pool, project_id, document_id))
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    except OperationNotCancellableError as exc:
        raise _operation_not_cancellable_error(str(exc)) from exc
    except DocumentOperationStateError as exc:
        raise _operation_state_conflict_error(str(exc)) from exc


@router.post("/{document_id}/retry", response_model=DocumentOperationRead, status_code=status.HTTP_202_ACCEPTED, responses={status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE, status.HTTP_409_CONFLICT: OPERATION_CONFLICT_RESPONSE, status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_ERROR_RESPONSE, status.HTTP_503_SERVICE_UNAVAILABLE: CAPTURE_UNAVAILABLE_RESPONSE})
async def retry_document_processing(
    request: Request,
    project_id: str,
    document_id: str,
    operation_id_header: OperationIdHeader = None,
    db=Depends(get_database),
    settings: Settings = Depends(get_settings),
    llm_provider: LLMProvider = Depends(get_llm_provider),
    streaming_questions: StreamingDraftGenerationManager = Depends(get_streaming_draft_generation_manager),
    worker_pool: DocumentWorkerPool = Depends(get_document_worker_pool),
) -> dict:
    operation_id = operation_id_header or str(uuid4())
    try:
        capture_coordinator = get_capture_coordinator(request)
        document = source_documents_repository.get_document(db, project_id, document_id)
        source_file = source_documents_repository.get_source_file(db, project_id, document_id)
        files = LocalSourceFileStore(settings)
        source_path = await asyncio.to_thread(files.verified_path, project_id, source_file.storage_path, source_file.sha256)
        canonical_suffix = source_path.suffix.lower()
        kind = "audio" if document.source_kind == "audio" else "pdf" if canonical_suffix == ".pdf" else "image"
        async_processing = bool(getattr(request.app.state, "document_processing_async_jobs", True))
        source: PreparedSource | StoredSourceReference
        if async_processing:
            source = StoredSourceReference(storage_path=str(source_path), sha256=source_file.sha256, canonical_suffix=canonical_suffix, filename=source_file.filename, kind=kind)
        else:
            content = await asyncio.to_thread(files.verified_content, project_id, source_file.storage_path, source_file.sha256)
            source = await asyncio.to_thread(prepare_source, content, max_pdf_pages=settings.max_pdf_pages, max_image_pixels=settings.max_image_pixels, filename=source_file.filename)
        document_operations.start_retry_operation(db, project_id=project_id, document_id=document_id, operation_id=operation_id)
        if async_processing:
            _submit_document_processing(worker_pool=worker_pool, db=db, settings=settings, llm_provider=llm_provider, streaming_questions=streaming_questions, project_id=project_id, document_id=document_id, operation_id=operation_id, source=source, coordinator=capture_coordinator)
            return _operation_read(document_operations.get_operation(db, project_id=project_id, operation_id=operation_id))
        _process_document_upload(db=db, settings=settings, llm_provider=llm_provider, streaming_questions=streaming_questions, project_id=project_id, document_id=document_id, operation_id=operation_id, source=source, coordinator=capture_coordinator)
        return _operation_read(document_operations.get_operation(db, project_id=project_id, operation_id=operation_id))
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    except InvalidSourceError as exc:
        raise _document_source_missing_error("The stored source file is unavailable for retry.") from exc
    except ProviderUnavailableError as exc:
        raise api_error(status.HTTP_503_SERVICE_UNAVAILABLE, "capture_runtime_unavailable", str(exc)) from exc
    except DocumentProcessingCanceledError as exc:
        raise _operation_canceled_error(str(exc)) from exc
    except DocumentOperationConflictError as exc:
        raise api_error(status.HTTP_409_CONFLICT, "document_retry_conflict", str(exc)) from exc
    except DocumentOperationStateError as exc:
        raise api_error(status.HTTP_409_CONFLICT, "document_retry_not_allowed", str(exc)) from exc


@router.get("/{document_id}/chunks", response_model=ChunkList)
def list_document_chunks(project_id: str, document_id: str, documents: DocumentRepository = Depends(get_document_repository)) -> dict:
    try:
        return {"items": [ChunkRead.from_chunk(chunk) for chunk in source_library.list_chunks(documents, project_id, document_id)]}
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@router.patch("/{document_id}/chunks/{chunk_id}", response_model=ChunkRead)
def update_document_chunk(project_id: str, document_id: str, chunk_id: str, body: ChunkUpdate, documents: DocumentRepository = Depends(get_document_repository)) -> dict:
    try:
        return ChunkRead.from_chunk(source_library.edit_chunk(documents, project_id, document_id, chunk_id, body.text))
    except ValueError as exc:
        raise validation_error(str(exc)) from exc
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@router.post("/{document_id}/chunks/{chunk_id}/translation", response_model=ChunkRead)
def translate_document_chunk(project_id: str, document_id: str, chunk_id: str, translator: ChunkTranslator = Depends(get_chunk_translator)) -> dict:
    try:
        return ChunkRead.from_chunk(source_library.translate_chunk(translator, project_id, document_id, chunk_id))
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    except Exception as exc:
        raise api_error(503, "translation_provider_unavailable", str(exc)) from exc


@router.post("/{document_id}/translations", response_model=ChunkList)
def translate_document_stale_chunks(project_id: str, document_id: str, translator: ChunkTranslator = Depends(get_chunk_translator)) -> dict:
    try:
        return {"items": [ChunkRead.from_chunk(chunk) for chunk in source_library.translate_stale_chunks(translator, project_id, document_id)]}
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    except Exception as exc:
        raise api_error(503, "translation_provider_unavailable", str(exc)) from exc


async def _read_limited_upload(file: UploadFile, max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total_size = 0
    while chunk := await file.read(1024 * 1024):
        total_size += len(chunk)
        if total_size > max_bytes:
            raise validation_error(f"Source file is too large; the limit is {max_bytes} bytes.")
        chunks.append(chunk)
    return b"".join(chunks)


def _store_uploaded_source(settings: Settings, *, project_id: str, content: bytes, canonical_suffix: str) -> tuple[str, FilePath]:
    sha256 = sha256_hex(content)
    return sha256, store_source_file(settings, project_id, sha256, content, canonical_suffix=canonical_suffix)


def _submit_document_processing(*, worker_pool: DocumentWorkerPool, db, settings: Settings, llm_provider: LLMProvider, streaming_questions: StreamingDraftGenerationManager, project_id: str, document_id: str, operation_id: str, source: StoredSourceReference, coordinator: CertPrepCaptureCoordinator) -> dict:
    item = DocumentWorkItem(
        operation_id=operation_id,
        run=partial(_process_document_upload, db=db, settings=settings, llm_provider=llm_provider, streaming_questions=streaming_questions, project_id=project_id, document_id=document_id, operation_id=operation_id, source=source, coordinator=coordinator, shutdown_requested=worker_pool.is_closed),
        cancel_queued=partial(_cancel_queued_operation, db, project_id=project_id, operation_id=operation_id),
    )
    try:
        worker_pool.submit(item)
    except Exception:
        document_operations.finish_failed(db, project_id=project_id, operation_id=operation_id, error="Document worker could not accept processing.")
        raise
    operation = document_operations.get_operation(db, project_id=project_id, operation_id=operation_id)
    if operation.document_id == document_id and operation.status == "running":
        return operation
    if worker_pool.cancel(operation_id) is False and operation.status == "cancel_requested":
        document_operations.acknowledge_cancellation(db, project_id=project_id, operation_id=operation_id)
    return document_operations.get_operation(db, project_id=project_id, operation_id=operation_id)



def _operation_read(operation: DocumentOperation) -> dict:
    """The operation as the DocumentOperationRead payload it has always been."""

    return asdict(operation)


def _cancel_queued_operation(db, *, project_id: str, operation_id: str) -> None:
    operation = document_operations.get_operation(db, project_id=project_id, operation_id=operation_id)
    if operation.status in {"canceled", "failed", "succeeded"}:
        return
    if operation.status != "cancel_requested":
        operation = document_operations.cancel_operation(db, project_id=project_id, operation_id=operation_id)
    if operation.status == "cancel_requested":
        document_operations.acknowledge_cancellation(db, project_id=project_id, operation_id=operation_id)


def _auto_generate_exam_items(db, *, provider: LLMProvider, project_id: str, document_id: str, limit: int) -> dict:
    chunks = [source_chunk_from_document_chunk(chunk) for chunk in source_documents_repository.get_source_chunks(db, project_id, document_id)]
    try:
        suggestions = [as_editable_question(suggestion) for suggestion in provider.generate_drafts(chunks, limit)]
    except ProviderUnavailableError:
        return _update_document_exam_state(db, project_id, document_id, 0)
    if not suggestions:
        return _update_document_exam_state(db, project_id, document_id, 0)
    drafts = mock_exams_repository.create_generated_drafts(db, project_id=project_id, document_id=document_id, suggestions=suggestions)
    return _update_document_exam_state(db, project_id, document_id, len(drafts))


def _process_document_upload(*, db, settings: Settings, llm_provider: LLMProvider, streaming_questions: StreamingDraftGenerationManager, project_id: str, document_id: str, operation_id: str, source: PreparedSource | StoredSourceReference, coordinator: CertPrepCaptureCoordinator, shutdown_requested: Callable[[], bool] = lambda: False) -> dict:
    try:
        return _process_capture_workbench_upload(db=db, settings=settings, llm_provider=llm_provider, streaming_questions=streaming_questions, project_id=project_id, document_id=document_id, operation_id=operation_id, source=source, coordinator=coordinator, should_shutdown=shutdown_requested)
    except DocumentProcessingCanceledError:
        try:
            if shutdown_requested():
                document_operations.cancel_operation(db, project_id=project_id, operation_id=operation_id)
            document_operations.acknowledge_cancellation(db, project_id=project_id, operation_id=operation_id)
        except (DocumentOperationStateError, OperationNotCancellableError):
            document_operations.finish_failed(db, project_id=project_id, operation_id=operation_id, error="Document processing was canceled but cleanup failed.")
        return source_documents_repository.get_document(db, project_id, document_id)
    except ProviderUnavailableError as exc:
        document_operations.finish_failed(db, project_id=project_id, operation_id=operation_id, error=str(exc))
        raise
    except CaptureRuntimeJobError as exc:
        if exc.code == "no_text_detected":
            return document_operations.finish_failed(
                db,
                project_id=project_id,
                operation_id=operation_id,
                error=str(exc),
                document_status="no_text_detected",
                extraction_method="none",
            )
        document_operations.finish_failed(
            db,
            project_id=project_id,
            operation_id=operation_id,
            error=str(exc),
        )
        raise
    except Exception:
        logger.exception("Document processing failed", extra={"project_id": project_id, "document_id": document_id})
        document_operations.finish_failed(db, project_id=project_id, operation_id=operation_id, error="Document processing failed.")
        raise


def _process_capture_workbench_upload(*, db, settings: Settings, llm_provider: LLMProvider, streaming_questions: StreamingDraftGenerationManager, project_id: str, document_id: str, operation_id: str, source: PreparedSource | StoredSourceReference, coordinator: CertPrepCaptureCoordinator, should_shutdown: Callable[[], bool]) -> dict:
    if isinstance(source, StoredSourceReference):
        source_bytes = LocalSourceFileStore(settings).verified_content(project_id, source.storage_path, source.sha256)
        source_sha256, file_name, canonical_suffix = source.sha256, source.filename, source.canonical_suffix
    else:
        source_bytes = source.raw_bytes
        source_sha256 = sha256_hex(source_bytes)
        file_name = source_documents_repository.get_document(db, project_id, document_id).filename
        canonical_suffix = source.canonical_suffix

    def should_cancel() -> bool:
        if should_shutdown():
            return True
        try:
            _ensure_document_operation_running(db, project_id=project_id, document_id=document_id, operation_id=operation_id)
        except DocumentProcessingCanceledError:
            return True
        return False

    try:
        capture = coordinator.capture(operation_id=operation_id, file_name=str(file_name), content=source_bytes, media_type=_capture_media_type(canonical_suffix), source_kind=CaptureSourceKind(source.kind), target_language="zh-Hant" if source.kind == "audio" else None, should_cancel=should_cancel)
    except CaptureRuntimeCanceledError as error:
        raise DocumentProcessingCanceledError(str(error)) from error
    except CaptureRuntimeRequirementUnavailableError as error:
        message = (
            PDF_OCR_UNAVAILABLE_MESSAGE if source.kind == "pdf" else str(error)
        )
        raise ProviderUnavailableError(message) from error
    except CaptureRuntimeJobError as error:
        if error.code == "requirement_unavailable":
            message = (
                PDF_OCR_UNAVAILABLE_MESSAGE
                if source.kind == "pdf"
                else "Capture Runtime extraction requirements are unavailable."
            )
            raise ProviderUnavailableError(message) from error
        raise
    finally:
        del source_bytes

    document = publish_capture_document(db, project_id=project_id, document_id=document_id, operation_id=operation_id, source_kind=source.kind, expected_sha256=source_sha256, document=capture.document, ocr_projection=capture.ocr_projection)
    try:
        coordinator.delete(capture.capture_id)
    except Exception:
        logger.warning("Validated Capture Runtime job could not be deleted after publication", extra={"project_id": project_id, "document_id": document_id, "capture_id": capture.capture_id})
    if document.chunks_count > 0:
        streaming_questions.enqueue_document(db, project_id=project_id, document_id=document_id)
        document = source_documents_repository.get_document(db, project_id, document_id)
    if settings.auto_generate_exam_on_upload and not settings.streaming_draft_generation_on_upload and document.chunks_count > 0:
        document = _auto_generate_exam_items(db, provider=llm_provider, project_id=project_id, document_id=document_id, limit=settings.auto_generate_exam_limit)
    return document


def _capture_media_type(canonical_suffix: str) -> str:
    return {".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4"}.get(canonical_suffix.lower(), "application/octet-stream")


def _ensure_document_operation_running(db, *, project_id: str, document_id: str, operation_id: str) -> None:
    operation = document_operations.get_operation(db, project_id=project_id, operation_id=operation_id)
    if not (operation.document_id == document_id and operation.status == "running" and operation.phase == "processing" and operation.cancellable):
        raise DocumentProcessingCanceledError("Document processing is no longer active.")


def _ensure_upload_operation_queued(db, *, project_id: str, operation_id: str) -> None:
    operation = document_operations.get_operation(db, project_id=project_id, operation_id=operation_id)
    if operation.status in {"cancel_requested", "canceled"}:
        raise DocumentProcessingCanceledError("Document upload was canceled before it started.")
    if not (operation.document_id is None and operation.status == "queued" and operation.phase == "uploading" and operation.cancellable):
        raise DocumentOperationStateError("Document upload operation is no longer available.")


def _update_document_exam_state(db, project_id: str, document_id: str, exam_item_count: int) -> dict:
    document = source_documents_repository.get_document(db, project_id, document_id)
    next_status = "processing" if document.status == "processing" else "ready" if document.has_text and document.chunks_count > 0 else "exam_failed"
    return source_documents_repository.update_exam_state(db, project_id=project_id, document_id=document_id, status=next_status, exam_item_count=exam_item_count)


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
