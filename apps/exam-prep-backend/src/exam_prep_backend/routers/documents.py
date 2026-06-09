from __future__ import annotations

from fastapi import APIRouter, Depends, File, UploadFile, status

from exam_prep_backend import documents_store, projects_store
from exam_prep_backend.config import Settings
from exam_prep_backend.database import Database
from exam_prep_backend.dependencies import get_database, get_settings
from exam_prep_backend.errors import InvalidPdfError, NotFoundError, not_found_error, validation_error
from exam_prep_backend.pdf_extraction import extract_pdf_pages
from exam_prep_backend.schemas import ChunkList, DocumentRead
from exam_prep_backend.storage import sha256_hex, store_pdf


router = APIRouter(prefix="/projects/{project_id}/documents", tags=["documents"])


@router.post("", response_model=DocumentRead, status_code=status.HTTP_201_CREATED)
async def upload_document(
    project_id: str,
    file: UploadFile = File(...),
    db: Database = Depends(get_database),
    settings: Settings = Depends(get_settings),
) -> dict:
    content = await file.read()
    if not content:
        raise validation_error("PDF is empty.")

    try:
        projects_store.ensure_project_exists(db, project_id)
        extraction = extract_pdf_pages(content)
        sha256 = sha256_hex(content)
        storage_path = store_pdf(settings, project_id, sha256, content)
        return documents_store.create_document(
            db,
            project_id=project_id,
            filename=file.filename or f"{sha256}.pdf",
            sha256=sha256,
            storage_path=str(storage_path),
            extraction=extraction,
        )
    except InvalidPdfError as exc:
        raise validation_error(str(exc)) from exc
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc


@router.get("/{document_id}/chunks", response_model=ChunkList)
def list_document_chunks(
    project_id: str,
    document_id: str,
    db: Database = Depends(get_database),
) -> dict:
    try:
        return {"items": documents_store.list_chunks(db, project_id, document_id)}
    except NotFoundError as exc:
        raise not_found_error(str(exc)) from exc
