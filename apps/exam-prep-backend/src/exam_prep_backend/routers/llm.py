from __future__ import annotations

from fastapi import APIRouter, Depends

from exam_prep_backend.dependencies import get_llm_provider
from exam_prep_backend.llm import LLMProvider
from exam_prep_backend.schemas import LLMHealthRead


router = APIRouter(prefix="/llm", tags=["llm"])


@router.get("/health", response_model=LLMHealthRead)
def llm_health(provider: LLMProvider = Depends(get_llm_provider)):
    return provider.health()
