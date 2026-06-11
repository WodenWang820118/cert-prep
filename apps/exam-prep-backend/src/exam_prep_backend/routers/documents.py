from __future__ import annotations

from fastapi import APIRouter, Depends, File, UploadFile, status

from exam_prep_backend.config import Settings
from exam_prep_backend.database import Database
from exam_prep_backend.dependencies import (
    get_database,
    get_llm_provider,
    get_ocr_provider,
    get_settings,
)
from exam_prep_backend.domains.mock_exams import repository as mock_exams_repository
from exam_prep_backend.domains.mock_exams.models import SourceChunk
from exam_prep_backend.domains.mock_exams.ports import DraftGenerationProvider as LLMProvider
from exam_prep_backend.domains.projects import repository as projects_repository
from exam_prep_backend.domains.source_documents import repository as source_documents_repository
from exam_prep_backend.domains.source_documents.ocr import OCRProvider
from exam_prep_backend.domains.source_documents.pdf_extraction import extract_pdf_pages
from exam_prep_backend.domains.source_documents.schemas import ChunkList, DocumentRead
from exam_prep_backend.domains.source_documents.storage import sha256_hex, store_pdf
from exam_prep_backend.errors import (
    InvalidPdfError,
    NotFoundError,
    ProviderUnavailableError,
    api_error,
    not_found_error,
    validation_error,
)


router = APIRouter(prefix="/projects/{project_id}/documents", tags=["documents"])


@router.post("", response_model=DocumentRead, status_code=status.HTTP_201_CREATED)
async def upload_document(
    project_id: str,
    file: UploadFile = File(...),
    db: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
    llm_provider: LLMProvider = Depends(get_llm_provider),
    ocr_provider: OCRProvider = Depends(get_ocr_provider),
) -> dict:
    _validate_pdf_upload_metadata(file)
    content = await _read_limited_upload(file, settings.max_upload_bytes)
    if not content:
        raise validation_error("PDF is empty.")

    try:
        projects_repository.ensure_project_exists(db, project_id)
        extraction = extract_pdf_pages(
            content,
            max_pages=settings.max_pdf_pages,
            max_page_text_chars=settings.max_page_text_chars,
            max_total_text_chars=settings.max_total_text_chars,
            ocr_provider=ocr_provider,
            ocr_render_scale=settings.ocr_render_scale,
        )
        sha256 = sha256_hex(content)
        storage_path = store_pdf(settings, project_id, sha256, content)
        document = source_documents_repository.create_document(
            db,
            project_id=project_id,
            filename=file.filename or f"{sha256}.pdf",
            sha256=sha256,
            storage_path=str(storage_path),
            extraction=extraction,
        )
        if settings.auto_generate_exam_on_upload and document["chunks_count"] > 0:
            document = _auto_generate_exam_items(
                db,
                provider=llm_provider,
                project_id=project_id,
                document_id=document["id"],
                limit=settings.auto_generate_exam_limit,
            )
        return document
    except InvalidPdfError as exc:
        raise validation_error(str(exc)) from exc
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
    except ProviderUnavailableError as exc:
        raise api_error(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="paddle_runtime_missing",
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
            raise validation_error(f"PDF is too large; the limit is {max_bytes} bytes.")
        chunks.append(chunk)
    return b"".join(chunks)


def _validate_pdf_upload_metadata(file: UploadFile) -> None:
    content_type = (file.content_type or "").lower()
    filename = (file.filename or "").lower()
    if content_type not in {"application/pdf", "application/x-pdf"} and not filename.endswith(
        ".pdf"
    ):
        raise validation_error("Only PDF uploads are supported.")


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
            text=chunk["text"],
            source_excerpt=chunk["source_excerpt"],
        )
        for chunk in source_documents_repository.get_source_chunks(db, project_id, document_id)
    ]
    try:
        suggestions = provider.generate_drafts(chunks, limit)
    except ProviderUnavailableError:
        return source_documents_repository.update_exam_state(
            db,
            project_id=project_id,
            document_id=document_id,
            status="exam_failed",
            exam_item_count=0,
        )

    if not suggestions:
        return source_documents_repository.update_exam_state(
            db,
            project_id=project_id,
            document_id=document_id,
            status="exam_failed",
            exam_item_count=0,
        )

    drafts = mock_exams_repository.create_generated_drafts(
        db,
        project_id=project_id,
        document_id=document_id,
        suggestions=suggestions,
    )
    return source_documents_repository.update_exam_state(
        db,
        project_id=project_id,
        document_id=document_id,
        status="ready",
        exam_item_count=len(drafts),
    )
