from __future__ import annotations

from pydantic import BaseModel


class OCRHealthRead(BaseModel):
    provider: str
    engine: str
    available: bool
    detail: str
    python_version: str
    paddle_version: str | None
    paddleocr_version: str | None
    selected_device: str | None
    cuda_available: bool
    gpu_count: int
    model_cache_dir: str | None
    fallback_reason: str | None
