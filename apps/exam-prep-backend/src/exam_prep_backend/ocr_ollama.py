from __future__ import annotations

import json
import platform
from time import perf_counter
from typing import Any

import ollama

from exam_prep_backend.errors import ProviderUnavailableError
from exam_prep_backend.ocr import OCRHealth, OCRPageResult


class OllamaOCRProvider:
    provider = "ollama"

    def __init__(self, host: str, model: str, timeout_seconds: float) -> None:
        self.host = host
        self.engine = model
        self._client = ollama.Client(host=host, timeout=timeout_seconds)

    def health(self) -> OCRHealth:
        try:
            response = self._client.list()
        except Exception as exc:
            return OCRHealth(
                provider=self.provider,
                engine=self.engine,
                available=False,
                detail=f"Ollama unavailable: {exc}",
                python_version=platform.python_version(),
                paddle_version=None,
                paddleocr_version=None,
                selected_device="ollama",
                cuda_available=False,
                gpu_count=0,
                model_cache_dir=None,
                fallback_reason=None,
            )

        model_names = _extract_model_names(response)
        available = self.engine in model_names
        return OCRHealth(
            provider=self.provider,
            engine=self.engine,
            available=available,
            detail="model available" if available else "model not found",
            python_version=platform.python_version(),
            paddle_version=None,
            paddleocr_version=None,
            selected_device="ollama",
            cuda_available=False,
            gpu_count=0,
            model_cache_dir=None,
            fallback_reason=None,
        )

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        started_at = perf_counter()
        response = self._client.chat(
            model=self.engine,
            messages=[
                {
                    "role": "user",
                    "content": (
                        "Extract all visible Japanese and English text from this JLPT exam "
                        f"PDF page image. Preserve question numbers, choices, and answer-key "
                        f"tables if visible. Return only JSON for page {page_number}."
                    ),
                    "images": [image_png],
                }
            ],
            format=OCR_SCHEMA,
            options={"temperature": 0, "num_ctx": 4096, "num_predict": 2048},
            think=False,
        )
        payload = _json_response(response)
        text = payload.get("text", "")
        return OCRPageResult(
            text=text if isinstance(text, str) else "",
            extraction_method="gemma_ocr",
            device="ollama",
            fallback_reason=None,
            duration_ms=_elapsed_ms(started_at),
        )


OCR_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"text": {"type": "string"}},
    "required": ["text"],
}


def _extract_model_names(response: Any) -> set[str]:
    models = getattr(response, "models", None)
    if models is None and isinstance(response, dict):
        models = response.get("models", [])
    names: set[str] = set()
    for model in models or []:
        name = getattr(model, "model", None)
        if name is None and isinstance(model, dict):
            name = model.get("model") or model.get("name")
        if isinstance(name, str):
            names.add(name)
    return names


def _json_response(response: Any) -> dict[str, Any]:
    message = getattr(response, "message", None)
    content = None
    if isinstance(message, dict):
        content = message.get("content")
    elif message is not None:
        content = getattr(message, "content", None)
    if content is None and isinstance(response, dict):
        content = response.get("message", {}).get("content")
    if not isinstance(content, str):
        raise ProviderUnavailableError("Ollama returned an unreadable OCR response.")
    try:
        payload = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ProviderUnavailableError("Ollama returned invalid OCR JSON.") from exc
    if not isinstance(payload, dict):
        raise ProviderUnavailableError("Ollama returned non-object OCR JSON.")
    return payload


def _elapsed_ms(started_at: float) -> int:
    return max(0, round((perf_counter() - started_at) * 1000))
