from __future__ import annotations

from dataclasses import asdict
import json
import platform
import tempfile
from pathlib import Path
from typing import Any

from exam_prep_backend.config import Settings
from exam_prep_backend.domains.runtime_installations import (
    parse_ocr_runtime_manifest,
    run_ocr_runtime_command,
)
from exam_prep_backend.domains.source_documents.ocr import OCRHealth, OCRPageResult
from exam_prep_backend.errors import ProviderUnavailableError


class ExternalPaddleOCRProvider:
    provider = "paddle"
    engine = "paddleocr"

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def health(self) -> OCRHealth:
        entrypoint = self._entrypoint()
        if entrypoint is None:
            return OCRHealth(
                provider=self.provider,
                engine=self.engine,
                available=False,
                detail="PaddleOCR runtime is not installed.",
                python_version=platform.python_version(),
                paddle_version=None,
                paddleocr_version=None,
                selected_device=None,
                cuda_available=False,
                gpu_count=0,
                model_cache_dir=str(self._settings.resolved_ocr_runtime_dir),
                fallback_reason=None,
                unavailable_reason="paddle_runtime_missing",
            )
        try:
            payload = self._run_json(entrypoint, ["--ocr-health", "--device", self._settings.ocr_device])
            return _health_from_payload(payload, runtime_dir=self._settings.resolved_ocr_runtime_dir)
        except Exception as exc:
            return OCRHealth(
                provider=self.provider,
                engine=self.engine,
                available=False,
                detail=f"PaddleOCR runtime is unhealthy: {exc}",
                python_version=platform.python_version(),
                paddle_version=None,
                paddleocr_version=None,
                selected_device=None,
                cuda_available=False,
                gpu_count=0,
                model_cache_dir=str(self._settings.resolved_ocr_runtime_dir),
                fallback_reason=None,
                unavailable_reason="paddle_runtime_unhealthy",
            )

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        entrypoint = self._entrypoint()
        if entrypoint is None:
            raise ProviderUnavailableError("PaddleOCR runtime is not installed.")

        with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as image_file:
            image_file.write(image_png)
            image_path = Path(image_file.name)
        try:
            payload = self._run_json(
                entrypoint,
                [
                    "--ocr-page",
                    str(image_path),
                    "--page-number",
                    str(page_number),
                    "--device",
                    self._settings.ocr_device,
                ],
            )
            return OCRPageResult(
                text=str(payload.get("text") or ""),
                extraction_method=str(payload.get("extraction_method") or "paddle_ocr_cpu"),
                device=_optional_string(payload.get("device")),
                fallback_reason=_optional_string(payload.get("fallback_reason")),
                duration_ms=int(payload.get("duration_ms") or 0),
            )
        finally:
            image_path.unlink(missing_ok=True)

    def _entrypoint(self) -> Path | None:
        runtime_dir = self._settings.resolved_ocr_runtime_dir
        manifest_path = runtime_dir / "runtime-manifest.json"
        if not manifest_path.is_file():
            return None
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest = parse_ocr_runtime_manifest(payload, manifest_path)
        entrypoint = runtime_dir / manifest.entrypoint
        return entrypoint if entrypoint.is_file() else None

    def _run_json(self, entrypoint: Path, args: list[str]) -> dict[str, Any]:
        output = run_ocr_runtime_command(entrypoint, args)
        try:
            payload = json.loads(output)
        except json.JSONDecodeError as exc:
            raise ProviderUnavailableError("PaddleOCR runtime returned invalid JSON.") from exc
        if not isinstance(payload, dict):
            raise ProviderUnavailableError("PaddleOCR runtime returned a non-object payload.")
        return payload


def _health_from_payload(payload: dict[str, Any], *, runtime_dir: Path) -> OCRHealth:
    fallback_reason = _optional_string(payload.get("fallback_reason"))
    return OCRHealth(
        provider=str(payload.get("provider") or "paddle"),
        engine=str(payload.get("engine") or "paddleocr"),
        available=bool(payload.get("available")),
        detail=str(payload.get("detail") or ""),
        python_version=str(payload.get("python_version") or platform.python_version()),
        paddle_version=_optional_string(payload.get("paddle_version")),
        paddleocr_version=_optional_string(payload.get("paddleocr_version")),
        selected_device=_optional_string(payload.get("selected_device")),
        cuda_available=bool(payload.get("cuda_available")),
        gpu_count=int(payload.get("gpu_count") or 0),
        model_cache_dir=_optional_string(payload.get("model_cache_dir")) or str(runtime_dir),
        fallback_reason=fallback_reason,
        unavailable_reason=_optional_string(payload.get("unavailable_reason")),
    )


def _optional_string(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def serialize_ocr_health(health: OCRHealth) -> dict[str, Any]:
    return asdict(health)
