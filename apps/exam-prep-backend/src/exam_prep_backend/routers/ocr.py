from __future__ import annotations

from fastapi import APIRouter, Depends

from exam_prep_backend.dependencies import get_ocr_provider
from exam_prep_backend.ocr import OCRProvider
from exam_prep_backend.schemas import OCRHealthRead


router = APIRouter(prefix="/ocr", tags=["ocr"])


@router.get("/health", response_model=OCRHealthRead)
def ocr_health(provider: OCRProvider = Depends(get_ocr_provider)):
    return provider.health()
