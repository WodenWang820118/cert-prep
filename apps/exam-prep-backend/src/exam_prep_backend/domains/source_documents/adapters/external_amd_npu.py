from __future__ import annotations

import json
import platform
import tempfile
import threading
from pathlib import Path
from typing import Any

from exam_prep_backend.config import Settings
from exam_prep_backend.domains.runtime_installations import (
    parse_ocr_runtime_manifest,
    run_ocr_runtime_command,
)
from exam_prep_backend.domains.runtime_installations.models import RuntimeRequirementKind
from exam_prep_backend.domains.source_documents.adapters.external_paddle import (
    _OcrWorkerPool,
    _health_from_payload,
    _ocr_result_from_payload,
)
from exam_prep_backend.domains.source_documents.ocr_contracts import OCRHealth, OCRPageResult
from exam_prep_backend.errors import ProviderUnavailableError


class ExternalAmdNpuOCRProvider:
    provider = "amd_npu"
    engine = "onnxruntime-windowsml-vitisai"

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self.page_workers = max(1, settings.ocr_page_workers)
        self._worker_pool: _OcrWorkerPool | None = None
        self._worker_pool_lock = threading.Lock()

    def health(self) -> OCRHealth:
        entrypoint = self._entrypoint()
        runtime_dir = self._settings.resolved_amd_npu_ocr_runtime_dir
        if entrypoint is None:
            return OCRHealth(
                provider=self.provider,
                engine=self.engine,
                available=False,
                detail="AMD NPU OCR runtime is not installed.",
                python_version=platform.python_version(),
                paddle_version=None,
                paddleocr_version=None,
                selected_device=None,
                cuda_available=False,
                gpu_count=0,
                model_cache_dir=str(runtime_dir),
                fallback_reason=None,
                unavailable_reason="amd_npu_runtime_missing",
            )
        try:
            payload = self._run_json(entrypoint, [*self._runtime_args(), "--ocr-health"])
            health = _health_from_payload(payload, runtime_dir=runtime_dir)
            if health.available:
                self._prewarm_primary_worker(entrypoint)
            return health
        except Exception as exc:
            return OCRHealth(
                provider=self.provider,
                engine=self.engine,
                available=False,
                detail=f"AMD NPU OCR runtime is unhealthy: {exc}",
                python_version=platform.python_version(),
                paddle_version=None,
                paddleocr_version=None,
                selected_device=None,
                cuda_available=False,
                gpu_count=0,
                model_cache_dir=str(runtime_dir),
                fallback_reason=None,
                unavailable_reason="amd_npu_runtime_unhealthy",
            )

    def prepare_for_document_ocr(self) -> None:
        entrypoint = self._entrypoint()
        if entrypoint is None:
            raise ProviderUnavailableError("AMD NPU OCR runtime is not installed.")
        self._prewarm_primary_worker(entrypoint, raise_on_failure=True)

    def close(self) -> None:
        self._reset_worker_pool()

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        entrypoint = self._entrypoint()
        if entrypoint is None:
            raise ProviderUnavailableError("AMD NPU OCR runtime is not installed.")

        with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as image_file:
            image_file.write(image_png)
            image_path = Path(image_file.name)
        try:
            try:
                return self._worker_pool_for(entrypoint).extract_page_text(
                    image_path=image_path,
                    page_number=page_number,
                )
            except ProviderUnavailableError:
                self._reset_worker_pool()
                return self._extract_page_text_oneshot(entrypoint, image_path, page_number)
        finally:
            image_path.unlink(missing_ok=True)

    def _prewarm_primary_worker(
        self,
        entrypoint: Path,
        *,
        raise_on_failure: bool = False,
    ) -> None:
        try:
            self._worker_pool_for(entrypoint, initial_worker_count=1).prewarm_primary_worker()
        except Exception as exc:
            self._reset_worker_pool()
            if raise_on_failure:
                if isinstance(exc, ProviderUnavailableError):
                    raise
                raise ProviderUnavailableError(f"AMD NPU OCR runtime is unhealthy: {exc}") from exc

    def _entrypoint(self) -> Path | None:
        runtime_dir = self._settings.resolved_amd_npu_ocr_runtime_dir
        manifest_path = runtime_dir / "runtime-manifest.json"
        if not manifest_path.is_file():
            return None
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest = parse_ocr_runtime_manifest(
            payload,
            manifest_path,
            expected_kind=RuntimeRequirementKind.AMD_NPU_OCR,
        )
        entrypoint = runtime_dir / manifest.entrypoint
        return entrypoint if entrypoint.is_file() else None

    def _run_json(self, entrypoint: Path, args: list[str]) -> dict[str, Any]:
        output = run_ocr_runtime_command(entrypoint, args)
        try:
            payload = json.loads(output)
        except json.JSONDecodeError as exc:
            raise ProviderUnavailableError("AMD NPU OCR runtime returned invalid JSON.") from exc
        if not isinstance(payload, dict):
            raise ProviderUnavailableError("AMD NPU OCR runtime returned a non-object payload.")
        return payload

    def _extract_page_text_oneshot(
        self,
        entrypoint: Path,
        image_path: Path,
        page_number: int,
    ) -> OCRPageResult:
        payload = self._run_json(
            entrypoint,
            [
                *self._runtime_args(),
                "--ocr-page",
                str(image_path),
                "--page-number",
                str(page_number),
            ],
        )
        return _ocr_result_from_payload(payload)

    def _worker_pool_for(
        self,
        entrypoint: Path,
        *,
        initial_worker_count: int | None = None,
    ) -> _OcrWorkerPool:
        with self._worker_pool_lock:
            if self._worker_pool is not None and self._worker_pool.entrypoint == entrypoint:
                return self._worker_pool
            if self._worker_pool is not None:
                self._worker_pool.close()
            self._worker_pool = _OcrWorkerPool(
                entrypoint=entrypoint,
                worker_args=[*self._runtime_args(), "--ocr-worker"],
                worker_label="AMD NPU OCR",
                worker_count=self.page_workers,
                initial_worker_count=initial_worker_count,
                timeout_seconds=self._settings.ocr_runtime_timeout_seconds,
            )
            return self._worker_pool

    def _reset_worker_pool(self) -> None:
        with self._worker_pool_lock:
            if self._worker_pool is not None:
                self._worker_pool.close()
                self._worker_pool = None

    def _runtime_args(self) -> list[str]:
        runtime_dir = self._settings.resolved_amd_npu_ocr_runtime_dir
        return [
            "--provider",
            "amd_npu",
            "--model-dir",
            str(runtime_dir),
            "--directml-device-id",
            str(self._settings.ocr_directml_device_id),
            "--amd-npu-device-id",
            self._settings.ocr_amd_npu_device_id,
            "--amd-npu-policy",
            self._settings.ocr_amd_npu_policy,
        ]
