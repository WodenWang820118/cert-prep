from __future__ import annotations

from fastapi import APIRouter, Depends

from exam_prep_backend.dependencies import get_ocr_provider
from exam_prep_backend.domains.provider_health.schemas import OCRHealthRead
from exam_prep_backend.domains.source_documents.ocr import OCRProvider


router = APIRouter(prefix="/ocr", tags=["ocr"])


@router.get("/health", response_model=OCRHealthRead)
def ocr_health(provider: OCRProvider = Depends(get_ocr_provider)):
    return provider.health()
