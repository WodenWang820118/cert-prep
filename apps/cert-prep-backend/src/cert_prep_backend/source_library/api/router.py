"""HTTP endpoints of the Source Library: documents, their chunks and their operations.

The endpoints convert DTOs and errors only; importing, retrying and the other rules run in
source_library.application.
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Path, Request, Response, UploadFile, status
from fastapi.responses import FileResponse

from cert_prep_contracts.documents import DocumentOperationRead

from cert_prep_backend.platform.dependencies import get_settings
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
from cert_prep_backend.projects.application.ports import ProjectRepository
from cert_prep_backend.source_library.application import use_cases as source_library
from cert_prep_backend.source_library.application.errors import SourceTooLarge
from cert_prep_backend.source_library.application.ports import (
    ChunkTranslator,
    DocumentOperationRepository,
    DocumentRepository,
    DocumentWork,
    ImportedDocumentDrafting,
    SourceExtraction,
    SourceFileStore,
)
from cert_prep_backend.source_library.domain.exceptions import SourceDocumentUnavailable
from cert_prep_backend.source_library.domain.operation import DocumentOperation
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


router = APIRouter(prefix="/projects/{project_id}/documents", tags=["documents"])
operations_router = APIRouter(
    prefix="/projects/{project_id}/document-operations",
    tags=["document-operations"],
)
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


def get_project_repository(request: Request) -> ProjectRepository:
    """The repositories, file store, translator and work create_app wires for this application."""

    return request.app.state.project_repository


def get_document_repository(request: Request) -> DocumentRepository:
    return request.app.state.document_repository


def get_document_operation_repository(request: Request) -> DocumentOperationRepository:
    return request.app.state.document_operation_repository


def get_source_file_store(request: Request) -> SourceFileStore:
    return request.app.state.source_file_store


def get_chunk_translator(request: Request) -> ChunkTranslator:
    return request.app.state.chunk_translator


def get_document_work(request: Request) -> DocumentWork:
    return request.app.state.document_work


def get_source_extraction(request: Request) -> SourceExtraction:
    extraction: SourceExtraction | None = request.app.state.source_extraction
    if extraction is None:
        raise api_error(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="capture_runtime_unavailable",
            message="Capture Runtime is not configured for this process.",
        )
    return extraction


def get_imported_document_drafting(request: Request) -> ImportedDocumentDrafting:
    return request.app.state.imported_document_drafting


def _processes_in_background(request: Request) -> bool:
    return bool(getattr(request.app.state, "document_processing_async_jobs", True))


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
    work: DocumentWork = Depends(get_document_work),
) -> dict:
    try:
        return _operation_read(source_library.cancel_operation(operations, work, project_id, operation_id))
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
    settings: Settings = Depends(get_settings),
    projects: ProjectRepository = Depends(get_project_repository),
    documents: DocumentRepository = Depends(get_document_repository),
    operations: DocumentOperationRepository = Depends(get_document_operation_repository),
    files: SourceFileStore = Depends(get_source_file_store),
    work: DocumentWork = Depends(get_document_work),
    extraction: SourceExtraction = Depends(get_source_extraction),
    drafting: ImportedDocumentDrafting = Depends(get_imported_document_drafting),
) -> dict:
    try:
        return await source_library.import_document(
            projects,
            documents,
            operations,
            files,
            work,
            extraction,
            drafting,
            project_id=project_id,
            operation_id=operation_id_header or str(uuid4()),
            upload=file,
            filename=file.filename,
            language_hint=language_hint,
            limits=settings,
            in_background=_processes_in_background(request),
        )
    except (SourceTooLarge, InvalidSourceError) as exc:
        raise validation_error(str(exc)) from exc
    except ProviderUnavailableError as exc:
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
def cancel_document_processing(project_id: str, document_id: str, operations: DocumentOperationRepository = Depends(get_document_operation_repository), work: DocumentWork = Depends(get_document_work)) -> dict:
    try:
        return _operation_read(source_library.cancel_processing(operations, work, project_id, document_id))
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
    settings: Settings = Depends(get_settings),
    documents: DocumentRepository = Depends(get_document_repository),
    operations: DocumentOperationRepository = Depends(get_document_operation_repository),
    files: SourceFileStore = Depends(get_source_file_store),
    work: DocumentWork = Depends(get_document_work),
    drafting: ImportedDocumentDrafting = Depends(get_imported_document_drafting),
) -> dict:
    operation_id = operation_id_header or str(uuid4())
    try:
        # Without Capture Runtime a retry is refused before the document is looked up.
        extraction = get_source_extraction(request)
        return _operation_read(
            await source_library.retry_document_processing(
                documents,
                operations,
                files,
                work,
                extraction,
                drafting,
                project_id=project_id,
                document_id=document_id,
                operation_id=operation_id,
                limits=settings,
                in_background=_processes_in_background(request),
            )
        )
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


def _operation_read(operation: DocumentOperation) -> dict:
    """The operation as the DocumentOperationRead payload it has always been."""

    return asdict(operation)


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
