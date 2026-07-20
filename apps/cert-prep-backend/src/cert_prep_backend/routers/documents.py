from __future__ import annotations

import asyncio
import hashlib
import logging
from collections.abc import Callable
from functools import partial
from pathlib import Path as FilePath
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
from fastapi.responses import FileResponse

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
    get_audio_document_worker_pool,
    get_audio_transcription_gate,
    get_database,
    get_document_ocr_provider_pool,
    get_document_ocr_worker_pool,
    get_llm_provider,
    get_runtime_installation_manager,
    get_settings,
    get_streaming_draft_generation_manager,
    get_transcription_provider,
)
from cert_prep_contracts.transcription import TranscriptionProvider
from cert_prep_contracts.runtime import RuntimeRequirementKind
from cert_prep_backend.domains.mock_exams import repository as mock_exams_repository
from cert_prep_backend.domains.mock_exams.models import source_chunk_from_record
from cert_prep_backend.domains.mock_exams.normalization import as_editable_question
from cert_prep_backend.domains.mock_exams.ports import DraftGenerationProvider as LLMProvider
from cert_prep_backend.domains.mock_exams.streaming import StreamingDraftGenerationManager
from cert_prep_backend.domains.projects import repository as projects_repository
from cert_prep_backend.domains.runtime_installations import RuntimeInstallationManager
from cert_prep_backend.domains.source_documents import operations as document_operations
from cert_prep_backend.domains.source_documents import repository as source_documents_repository
from cert_prep_backend.domains.source_documents.audio_transcription_gate import (
    AudioTranscriptionGate,
)
from cert_prep_backend.domains.source_documents.document_worker_pool import (
    DocumentWorkerPool,
    DocumentWorkItem,
)
from cert_prep_backend.domains.source_documents.ocr_provider_pool import (
    DocumentOCRProviderPool,
)
from cert_prep_backend.domains.source_documents.pdf_extraction import (
    PdfExtractionProgress,
)
from cert_prep_backend.domains.source_documents.schemas import (
    ChunkList,
    ChunkRead,
    ChunkUpdate,
    DocumentList,
    DocumentRead,
)
from cert_prep_backend.domains.source_documents.audio import (
    BATCH_TRANSLATION_KEEP_ALIVE,
    OllamaTraditionalChineseTranslator,
    audio_operation_is_active,
    complete_audio_operation,
    set_operation_phase,
    transcribe_audio,
    translate_chunk,
    translate_stale_chunks,
)
from cert_prep_backend.domains.source_documents.source_preparation import (
    PreparedSource,
    StoredSourceReference,
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
AUDIO_SOURCE_CONTENT = {
    "application/octet-stream": {
        "schema": {"type": "string", "format": "binary"},
    }
}
AUDIO_MEDIA_TYPES = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
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
    audio_workers: DocumentWorkerPool = Depends(get_audio_document_worker_pool),
    ocr_workers: DocumentWorkerPool = Depends(get_document_ocr_worker_pool),
) -> dict:
    try:
        operation = document_operations.cancel_operation(
            db,
            project_id=project_id,
            operation_id=operation_id,
        )
        if _cancel_queued_document_work(audio_workers, ocr_workers, operation_id):
            return document_operations.get_operation(
                db,
                project_id=project_id,
                operation_id=operation_id,
            )
        return operation
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
        description="A PDF, PNG, JPEG/JPG, static WebP, MP3, WAV, or M4A source file.",
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
    transcription_provider: TranscriptionProvider = Depends(get_transcription_provider),
    audio_transcription_gate: AudioTranscriptionGate = Depends(
        get_audio_transcription_gate
    ),
    audio_workers: DocumentWorkerPool = Depends(get_audio_document_worker_pool),
    ocr_workers: DocumentWorkerPool = Depends(get_document_ocr_worker_pool),
    runtime_installations: RuntimeInstallationManager = Depends(
        get_runtime_installation_manager
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
        is_audio_name = FilePath(file.filename or "").suffix.lower() in {".mp3", ".wav", ".m4a"}
        upload_limit = (
            settings.max_audio_upload_bytes if is_audio_name else settings.max_upload_bytes
        )
        content = await _read_limited_upload(file, upload_limit)
        prepared_source = await asyncio.to_thread(
            prepare_source,
            content,
            max_pdf_pages=settings.max_pdf_pages,
            max_image_pixels=settings.max_image_pixels,
            filename=file.filename,
        )
        if prepared_source.kind == "audio":
            _ensure_whisper_models_ready(runtime_installations)
        async_processing = bool(
            getattr(request.app.state, "document_processing_async_jobs", True)
        )
        try:
            if prepared_source.kind != "audio":
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
        sha256, storage_path = await asyncio.to_thread(
            _store_uploaded_source,
            settings,
            project_id=project_id,
            content=content,
            canonical_suffix=prepared_source.canonical_suffix,
        )
        _ensure_upload_operation_queued(
            db,
            project_id=project_id,
            operation_id=operation_id,
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
            source_kind="audio" if prepared_source.kind == "audio" else "document",
            duration_ms=prepared_source.duration_ms,
        )
        if async_processing:
            processing_source = StoredSourceReference(
                storage_path=str(storage_path),
                sha256=sha256,
                canonical_suffix=prepared_source.canonical_suffix,
                filename=document["filename"],
                kind=prepared_source.kind,
            )
            worker_pool = (
                audio_workers if processing_source.kind == "audio" else ocr_workers
            )
            _submit_document_processing(
                worker_pool=worker_pool,
                db=db,
                settings=settings,
                llm_provider=llm_provider,
                ocr_provider_pool=ocr_provider_pool,
                streaming_questions=streaming_questions,
                project_id=project_id,
                document_id=document["id"],
                operation_id=operation_id,
                source=processing_source,
                transcription_provider=transcription_provider,
                audio_transcription_gate=audio_transcription_gate,
            )
            return source_documents_repository.get_document(
                db,
                project_id,
                document["id"],
            )

        synchronous_source: PreparedSource | StoredSourceReference = prepared_source
        if prepared_source.kind == "audio":
            synchronous_source = StoredSourceReference(
                storage_path=str(storage_path),
                sha256=sha256,
                canonical_suffix=prepared_source.canonical_suffix,
                filename=document["filename"],
                kind="audio",
            )
        return _process_document_upload(
            db,
            settings,
            llm_provider,
            ocr_provider_pool,
            streaming_questions,
            project_id,
            document["id"],
            operation_id,
            synchronous_source,
            transcription_provider,
            audio_transcription_gate,
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


@router.get(
    "/{document_id}/source",
    response_class=FileResponse,
    responses={
        status.HTTP_200_OK: {
            "description": "The authenticated canonical audio source.",
            "content": AUDIO_SOURCE_CONTENT,
        },
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_409_CONFLICT: {
            "model": ApiErrorRead,
            "description": "The source is not playable audio or failed integrity validation.",
        },
    },
)
def get_document_audio_source(
    project_id: str,
    document_id: str,
    db: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> FileResponse:
    """Serve an authenticated, integrity-checked canonical audio source."""

    try:
        document = source_documents_repository.get_document(db, project_id, document_id)
        if document["source_kind"] != "audio":
            raise _audio_source_unavailable_error(
                "Only audio documents have a playable source."
            )
        source_file = source_documents_repository.get_source_file(
            db,
            project_id,
            document_id,
        )
        source_path = _resolve_stored_source_path(
            settings,
            project_id=project_id,
            storage_path=source_file.storage_path,
        )
        media_type = AUDIO_MEDIA_TYPES.get(source_path.suffix.lower())
        if media_type is None or _sha256_file(source_path) != source_file.sha256:
            raise _audio_source_unavailable_error(
                "The stored audio source failed integrity verification."
            )
        return FileResponse(
            source_path,
            media_type=media_type,
            filename=source_file.filename,
            content_disposition_type="inline",
            headers={"Cache-Control": "private, no-store"},
        )
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
    audio_workers: DocumentWorkerPool = Depends(get_audio_document_worker_pool),
    ocr_workers: DocumentWorkerPool = Depends(get_document_ocr_worker_pool),
) -> dict:
    try:
        operation = document_operations.cancel_document_processing(
            db,
            project_id=project_id,
            document_id=document_id,
        )
        if _cancel_queued_document_work(
            audio_workers,
            ocr_workers,
            operation["id"],
        ):
            return document_operations.get_operation(
                db,
                project_id=project_id,
                operation_id=operation["id"],
            )
        return operation
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
    transcription_provider: TranscriptionProvider = Depends(get_transcription_provider),
    audio_transcription_gate: AudioTranscriptionGate = Depends(
        get_audio_transcription_gate
    ),
    audio_workers: DocumentWorkerPool = Depends(get_audio_document_worker_pool),
    ocr_workers: DocumentWorkerPool = Depends(get_document_ocr_worker_pool),
    runtime_installations: RuntimeInstallationManager = Depends(
        get_runtime_installation_manager
    ),
) -> dict:
    operation_id = operation_id_header or str(uuid4())
    try:
        document = source_documents_repository.get_document(
            db,
            project_id,
            document_id,
        )
        source_file = source_documents_repository.get_source_file(
            db,
            project_id,
            document_id,
        )
        async_processing = bool(
            getattr(request.app.state, "document_processing_async_jobs", True)
        )
        source_path = await asyncio.to_thread(
            _verify_stored_source_file,
            settings,
            project_id=project_id,
            storage_path=source_file.storage_path,
            expected_sha256=source_file.sha256,
        )
        processing_source: PreparedSource | StoredSourceReference
        if async_processing:
            canonical_suffix = source_path.suffix.lower()
            processing_source = StoredSourceReference(
                storage_path=str(source_path),
                sha256=source_file.sha256,
                canonical_suffix=canonical_suffix,
                filename=source_file.filename,
                kind=(
                    "audio"
                    if document["source_kind"] == "audio"
                    else "pdf"
                    if canonical_suffix == ".pdf"
                    else "image"
                ),
            )
            if processing_source.kind == "audio":
                _ensure_whisper_models_ready(runtime_installations)
            else:
                await _prepare_document_ocr_provider_pool(ocr_provider_pool)
        else:
            content = await asyncio.to_thread(
                _read_stored_source_file,
                settings,
                project_id=project_id,
                storage_path=source_file.storage_path,
                expected_sha256=source_file.sha256,
            )
            processing_source = await asyncio.to_thread(
                prepare_source,
                content,
                max_pdf_pages=settings.max_pdf_pages,
                max_image_pixels=settings.max_image_pixels,
                filename=source_file.filename,
            )
            if processing_source.kind == "audio":
                _ensure_whisper_models_ready(runtime_installations)
                processing_source = StoredSourceReference(
                    storage_path=str(source_path),
                    sha256=source_file.sha256,
                    canonical_suffix=source_path.suffix.lower(),
                    filename=source_file.filename,
                    kind="audio",
                )
            else:
                await _prepare_document_ocr_provider_pool(ocr_provider_pool)
        document_operations.start_retry_operation(
            db,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
        )
        if async_processing:
            if not isinstance(processing_source, StoredSourceReference):
                raise RuntimeError("Async document processing requires a stored source.")
            worker_pool = (
                audio_workers if processing_source.kind == "audio" else ocr_workers
            )
            submitted_operation = _submit_document_processing(
                worker_pool=worker_pool,
                db=db,
                settings=settings,
                llm_provider=llm_provider,
                ocr_provider_pool=ocr_provider_pool,
                streaming_questions=streaming_questions,
                project_id=project_id,
                document_id=document_id,
                operation_id=operation_id,
                source=processing_source,
                transcription_provider=transcription_provider,
                audio_transcription_gate=audio_transcription_gate,
            )
            return submitted_operation

        _process_document_upload(
            db,
            settings,
            llm_provider,
            ocr_provider_pool,
            streaming_questions,
            project_id,
            document_id,
            operation_id,
            processing_source,
            transcription_provider,
            audio_transcription_gate,
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


@router.patch("/{document_id}/chunks/{chunk_id}", response_model=ChunkRead)
def update_document_chunk(
    project_id: str,
    document_id: str,
    chunk_id: str,
    body: ChunkUpdate,
    db: Database = Depends(get_database),
) -> dict:
    try:
        return source_documents_repository.update_chunk_text(
            db, project_id, document_id, chunk_id, body.text
        )
    except ValueError as exc:
        raise validation_error(str(exc)) from exc
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@router.post("/{document_id}/chunks/{chunk_id}/translation", response_model=ChunkRead)
def translate_document_chunk(
    project_id: str,
    document_id: str,
    chunk_id: str,
    db: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> dict:
    try:
        return translate_chunk(
            db,
            translator=OllamaTraditionalChineseTranslator(settings),
            project_id=project_id,
            document_id=document_id,
            chunk_id=chunk_id,
        )
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    except Exception as exc:
        raise api_error(503, "translation_provider_unavailable", str(exc)) from exc


@router.post("/{document_id}/translations", response_model=ChunkList)
def translate_document_stale_chunks(
    project_id: str,
    document_id: str,
    db: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> dict:
    try:
        return {
            "items": translate_stale_chunks(
                db,
                translator=OllamaTraditionalChineseTranslator(
                    settings,
                    keep_alive=BATCH_TRANSLATION_KEEP_ALIVE,
                ),
                project_id=project_id,
                document_id=document_id,
            )
        }
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
            raise validation_error(
                f"Source file is too large; the limit is {max_bytes} bytes."
            )
        chunks.append(chunk)
    return b"".join(chunks)


def _ensure_whisper_models_ready(
    runtime_installations: RuntimeInstallationManager,
) -> None:
    requirement = runtime_installations.requirement(
        RuntimeRequirementKind.WHISPER_MODELS
    )
    if requirement is not None and requirement.available:
        return
    raise api_error(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        code="whisper_models_missing",
        message=(
            "Whisper speech models must be downloaded with user consent before "
            "audio upload."
        ),
        details={
            "missing_requirement": (
                requirement.kind.value
                if requirement is not None
                else RuntimeRequirementKind.WHISPER_MODELS.value
            )
        },
    )


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
    source_path = _resolve_stored_source_path(
        settings,
        project_id=project_id,
        storage_path=storage_path,
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


def _verify_stored_source_file(
    settings: Settings,
    *,
    project_id: str,
    storage_path: str,
    expected_sha256: str,
) -> FilePath:
    source_path = _resolve_stored_source_path(
        settings,
        project_id=project_id,
        storage_path=storage_path,
    )
    try:
        valid = _sha256_file(source_path) == expected_sha256
    except HTTPException as exc:
        raise _document_source_missing_error(
            "The stored source file is unavailable for retry."
        ) from exc
    if not valid:
        raise _document_source_missing_error(
            "The stored source file failed integrity verification."
        )
    return source_path


def _resolve_stored_source_path(
    settings: Settings,
    *,
    project_id: str,
    storage_path: str,
) -> FilePath:
    expected_root = (settings.data_dir / "uploads" / project_id).resolve()
    try:
        source_path = FilePath(storage_path).resolve(strict=True)
        source_path.relative_to(expected_root)
        stat = source_path.stat()
    except (OSError, ValueError) as exc:
        raise _document_source_missing_error(
            "The stored source file is unavailable."
        ) from exc
    source_limit = (
        settings.max_audio_upload_bytes
        if source_path.suffix.lower() in AUDIO_MEDIA_TYPES
        else settings.max_upload_bytes
    )
    if not source_path.is_file() or stat.st_size <= 0 or stat.st_size > source_limit:
        raise _document_source_missing_error(
            "The stored source file is unavailable."
        )
    return source_path


def _sha256_file(source_path: FilePath) -> str:
    digest = hashlib.sha256()
    try:
        with source_path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
    except OSError as exc:
        raise _audio_source_unavailable_error(
            "The stored audio source is unavailable."
        ) from exc
    return digest.hexdigest()


def _store_uploaded_source(
    settings: Settings,
    *,
    project_id: str,
    content: bytes,
    canonical_suffix: str,
) -> tuple[str, FilePath]:
    sha256 = sha256_hex(content)
    storage_path = store_source_file(
        settings,
        project_id,
        sha256,
        content,
        canonical_suffix=canonical_suffix,
    )
    return sha256, storage_path


def _submit_document_processing(
    *,
    worker_pool: DocumentWorkerPool,
    db: Database,
    settings: Settings,
    llm_provider: LLMProvider,
    ocr_provider_pool: DocumentOCRProviderPool,
    streaming_questions: StreamingDraftGenerationManager,
    project_id: str,
    document_id: str,
    operation_id: str,
    source: StoredSourceReference,
    transcription_provider: TranscriptionProvider,
    audio_transcription_gate: AudioTranscriptionGate,
) -> dict:
    item = DocumentWorkItem(
        operation_id=operation_id,
        run=partial(
            _process_document_upload,
            db,
            settings,
            llm_provider,
            ocr_provider_pool,
            streaming_questions,
            project_id,
            document_id,
            operation_id,
            source,
            transcription_provider,
            audio_transcription_gate,
            shutdown_requested=worker_pool.is_closed,
        ),
        cancel_queued=partial(
            _cancel_queued_audio_operation,
            db,
            project_id=project_id,
            operation_id=operation_id,
        ),
    )
    try:
        worker_pool.submit(item)
    except Exception:
        logger.exception(
            "Document worker submission failed",
            extra={"project_id": project_id, "document_id": document_id},
        )
        document_operations.finish_failed(
            db,
            project_id=project_id,
            operation_id=operation_id,
            error="Document worker could not accept processing.",
        )
        raise

    operation = document_operations.get_operation(
        db,
        project_id=project_id,
        operation_id=operation_id,
    )
    if operation["document_id"] == document_id and operation["status"] == "running":
        return operation

    removed = worker_pool.cancel(operation_id)
    if not removed and operation["status"] == "cancel_requested":
        document_operations.acknowledge_cancellation(
            db,
            project_id=project_id,
            operation_id=operation_id,
        )
        worker_pool.cancel(operation_id)
    return document_operations.get_operation(
        db,
        project_id=project_id,
        operation_id=operation_id,
    )


def _cancel_queued_document_work(
    audio_workers: DocumentWorkerPool,
    ocr_workers: DocumentWorkerPool,
    operation_id: str,
) -> bool:
    return audio_workers.cancel(operation_id) or ocr_workers.cancel(operation_id)


def _cancel_queued_audio_operation(
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
    if operation["status"] in {"canceled", "failed", "succeeded"}:
        return
    if operation["status"] != "cancel_requested":
        operation = document_operations.cancel_operation(
            db,
            project_id=project_id,
            operation_id=operation_id,
        )
    if operation["status"] == "cancel_requested":
        document_operations.acknowledge_cancellation(
            db,
            project_id=project_id,
            operation_id=operation_id,
        )


def _auto_generate_exam_items(
    db: Database,
    *,
    provider: LLMProvider,
    project_id: str,
    document_id: str,
    limit: int,
) -> dict:
    chunks = [
        source_chunk_from_record(chunk)
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
    source: PreparedSource | StoredSourceReference,
    transcription_provider: TranscriptionProvider,
    audio_transcription_gate: AudioTranscriptionGate,
    *,
    shutdown_requested: Callable[[], bool] | None = None,
) -> dict:
    should_shutdown = shutdown_requested or (lambda: False)

    def record_progress(progress: PdfExtractionProgress) -> None:
        if should_shutdown():
            raise DocumentProcessingCanceledError(
                "Document processing was canceled because the backend is shutting down."
            )
        _ensure_document_operation_running(
            db,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
        )
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
        if source.kind == "audio":
            if not isinstance(source, StoredSourceReference):
                raise InvalidSourceError(
                    "Audio processing requires a stored canonical source."
                )
            with audio_transcription_gate.acquire(
                should_cancel=lambda: not audio_operation_is_active(
                    db,
                    project_id=project_id,
                    document_id=document_id,
                    operation_id=operation_id,
                    phase="processing",
                )
            ):
                source_bytes = _read_stored_source_file(
                    settings,
                    project_id=project_id,
                    storage_path=source.storage_path,
                    expected_sha256=source.sha256,
                )
                if audio_transcription_gate.is_closed():
                    raise DocumentProcessingCanceledError(
                        "Audio transcription was canceled because the backend is shutting down."
                    )
                set_operation_phase(
                    db,
                    project_id=project_id,
                    document_id=document_id,
                    operation_id=operation_id,
                    phase="transcribing",
                )
                transcribe_audio(
                    db,
                    settings=settings,
                    provider=transcription_provider,
                    project_id=project_id,
                    document_id=document_id,
                    operation_id=operation_id,
                    source_bytes=source_bytes,
                    suffix=source.canonical_suffix,
                    shutdown_requested=audio_transcription_gate.is_closed,
                )
                del source_bytes
            if audio_transcription_gate.is_closed():
                raise DocumentProcessingCanceledError(
                    "Audio translation was canceled because the backend is shutting down."
                )
            set_operation_phase(
                db,
                project_id=project_id,
                document_id=document_id,
                operation_id=operation_id,
                phase="translating",
            )
            translation_succeeded = True
            try:
                translate_stale_chunks(
                    db,
                    translator=OllamaTraditionalChineseTranslator(
                        settings,
                        keep_alive=BATCH_TRANSLATION_KEEP_ALIVE,
                    ),
                    project_id=project_id,
                    document_id=document_id,
                    should_cancel=lambda: (
                        audio_transcription_gate.is_closed()
                        or not audio_operation_is_active(
                            db,
                            project_id=project_id,
                            document_id=document_id,
                            operation_id=operation_id,
                            phase="translating",
                        )
                    ),
                    operation_id=operation_id,
                    reconcile_document_status=False,
                )
            except DocumentProcessingCanceledError:
                raise
            except Exception:
                translation_succeeded = False
            if audio_transcription_gate.is_closed():
                raise DocumentProcessingCanceledError(
                    "Audio completion was canceled because the backend is shutting down."
                )
            complete_audio_operation(
                db,
                project_id=project_id,
                document_id=document_id,
                operation_id=operation_id,
                translation_succeeded=translation_succeeded,
            )
            document = source_documents_repository.get_document(db, project_id, document_id)
            if document["chunks_count"] > 0:
                streaming_questions.enqueue_document(
                    db, project_id=project_id, document_id=document_id
                )
            return source_documents_repository.get_document(db, project_id, document_id)
        if isinstance(source, StoredSourceReference):
            _ensure_document_operation_running(
                db,
                project_id=project_id,
                document_id=document_id,
                operation_id=operation_id,
            )
            if should_shutdown():
                raise DocumentProcessingCanceledError(
                    "Document decoding was canceled because the backend is shutting down."
                )
            source_bytes = _read_stored_source_file(
                settings,
                project_id=project_id,
                storage_path=source.storage_path,
                expected_sha256=source.sha256,
            )
            _ensure_document_operation_running(
                db,
                project_id=project_id,
                document_id=document_id,
                operation_id=operation_id,
            )
            if should_shutdown():
                raise DocumentProcessingCanceledError(
                    "Document preparation was canceled because the backend is shutting down."
                )
            expected_kind = source.kind
            source = prepare_source(
                source_bytes,
                max_pdf_pages=settings.max_pdf_pages,
                max_image_pixels=settings.max_image_pixels,
                filename=source.filename,
            )
            if source.kind != expected_kind:
                raise InvalidSourceError(
                    "Stored document type no longer matches its validated source."
                )
        _ensure_document_operation_running(
            db,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
        )
        if should_shutdown():
            raise DocumentProcessingCanceledError(
                "Document OCR was canceled because the backend is shutting down."
            )
        with ocr_provider_pool.acquire() as ocr_provider:
            _ensure_document_operation_running(
                db,
                project_id=project_id,
                document_id=document_id,
                operation_id=operation_id,
            )
            if should_shutdown():
                raise DocumentProcessingCanceledError(
                    "Document OCR was canceled because the backend is shutting down."
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
        if should_shutdown():
            raise DocumentProcessingCanceledError(
                "Document completion was canceled because the backend is shutting down."
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
        try:
            if should_shutdown() or (
                source.kind == "audio" and audio_transcription_gate.is_closed()
            ):
                document_operations.cancel_operation(
                    db,
                    project_id=project_id,
                    operation_id=operation_id,
                )
            document_operations.acknowledge_cancellation(
                db,
                project_id=project_id,
                operation_id=operation_id,
            )
        except (
            DocumentOperationStateError,
            OperationNotCancellableError,
        ) as cleanup_exc:
            logger.warning(
                "Cancellation cleanup could not acknowledge the operation; "
                "falling back to finish_failed.",
                extra={
                    "project_id": project_id,
                    "document_id": document_id,
                    "operation_id": operation_id,
                    "cleanup_error": str(cleanup_exc),
                },
            )
            try:
                document_operations.finish_failed(
                    db,
                    project_id=project_id,
                    operation_id=operation_id,
                    error="Document processing was canceled but cleanup failed.",
                )
            except Exception:
                logger.exception(
                    "Cancellation fallback finish_failed also failed; "
                    "operation may require restart recovery.",
                    extra={
                        "project_id": project_id,
                        "document_id": document_id,
                        "operation_id": operation_id,
                    },
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
        logger.exception(
            "Document processing failed",
            extra={"project_id": project_id, "document_id": document_id},
        )
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


def _audio_source_unavailable_error(message: str) -> HTTPException:
    return api_error(status.HTTP_409_CONFLICT, "audio_source_unavailable", message)
