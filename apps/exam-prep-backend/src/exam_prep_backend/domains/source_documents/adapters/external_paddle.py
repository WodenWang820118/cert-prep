from __future__ import annotations

import atexit
from collections import deque
from dataclasses import asdict
import json
import platform
from queue import Empty, Queue
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Any
from uuid import uuid4

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
        self.page_workers = max(1, settings.ocr_page_workers)
        self._worker_pool: _OcrWorkerPool | None = None
        self._worker_pool_lock = threading.Lock()

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
            payload = self._run_json(
                entrypoint,
                ["--ocr-health", "--device", self._settings.ocr_device],
            )
            health = _health_from_payload(
                payload,
                runtime_dir=self._settings.resolved_ocr_runtime_dir,
            )
            if health.available:
                self._prewarm_primary_worker(entrypoint)
            return health
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

    def prepare_for_document_ocr(self) -> None:
        entrypoint = self._entrypoint()
        if entrypoint is None:
            raise ProviderUnavailableError("PaddleOCR runtime is not installed.")
        self._prewarm_primary_worker(entrypoint, raise_on_failure=True)

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
                raise ProviderUnavailableError(
                    f"PaddleOCR runtime is unhealthy: {exc}"
                ) from exc

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        entrypoint = self._entrypoint()
        if entrypoint is None:
            raise ProviderUnavailableError("PaddleOCR runtime is not installed.")

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

    def _extract_page_text_oneshot(
        self,
        entrypoint: Path,
        image_path: Path,
        page_number: int,
    ) -> OCRPageResult:
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
                device=self._settings.ocr_device,
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


class _OcrWorkerPool:
    def __init__(
        self,
        *,
        entrypoint: Path,
        device: str,
        worker_count: int,
        initial_worker_count: int | None = None,
        timeout_seconds: float,
    ) -> None:
        self.entrypoint = entrypoint
        self.worker_count = max(1, worker_count)
        self._device = device
        self._timeout_seconds = timeout_seconds
        self._lock = threading.Lock()
        self._next_worker_index = 0
        self._primary_worker_prewarmed = False
        self._workers: list[_JsonlOcrWorker] = []
        worker_start_count = (
            self.worker_count
            if initial_worker_count is None
            else min(max(1, initial_worker_count), self.worker_count)
        )
        try:
            self._workers = [self._create_worker() for _ in range(worker_start_count)]
        except Exception:
            self.close()
            raise
        atexit.register(self.close)

    def prewarm_primary_worker(self) -> None:
        with self._lock:
            if self._primary_worker_prewarmed:
                return
            worker = self._worker_at(0)

        image_path = _write_prewarm_png()
        try:
            worker.extract_page_text(image_path=image_path, page_number=1)
        finally:
            image_path.unlink(missing_ok=True)

        with self._lock:
            self._primary_worker_prewarmed = True

    def extract_page_text(self, *, image_path: Path, page_number: int) -> OCRPageResult:
        payload = self._next_worker().extract_page_text(
            image_path=image_path,
            page_number=page_number,
        )
        return _ocr_result_from_payload(payload)

    def close(self) -> None:
        for worker in self._workers:
            worker.close()

    def _create_worker(self) -> _JsonlOcrWorker:
        return _JsonlOcrWorker(
            entrypoint=self.entrypoint,
            device=self._device,
            timeout_seconds=self._timeout_seconds,
        )

    def _worker_at(self, index: int) -> _JsonlOcrWorker:
        while len(self._workers) <= index:
            self._workers.append(self._create_worker())
        return self._workers[index]

    def _next_worker(self) -> _JsonlOcrWorker:
        with self._lock:
            if not self._workers:
                self._workers.append(self._create_worker())
            if (
                self._next_worker_index >= len(self._workers)
                and len(self._workers) < self.worker_count
            ):
                self._workers.append(self._create_worker())
            worker = self._workers[self._next_worker_index % len(self._workers)]
            self._next_worker_index += 1
            return worker


class _JsonlOcrWorker:
    def __init__(self, *, entrypoint: Path, device: str, timeout_seconds: float) -> None:
        self._timeout_seconds = max(1.0, timeout_seconds)
        self._lock = threading.Lock()
        self._stderr_lines: deque[str] = deque(maxlen=20)
        self._responses: Queue[str | None] = Queue()
        self._process = subprocess.Popen(
            _entrypoint_command(entrypoint, ["--ocr-worker", "--device", device]),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def extract_page_text(self, *, image_path: Path, page_number: int) -> dict[str, Any]:
        job_id = str(uuid4())
        with self._lock:
            self._ensure_running()
            try:
                assert self._process.stdin is not None
                self._process.stdin.write(
                    json.dumps(
                        {
                            "id": job_id,
                            "image_path": str(image_path),
                            "page_number": page_number,
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
                self._process.stdin.flush()
            except Exception as exc:
                raise ProviderUnavailableError(
                    f"PaddleOCR worker could not accept a job: {exc}"
                ) from exc

            try:
                line = self._responses.get(timeout=self._timeout_seconds)
            except Empty as exc:
                self.close()
                raise ProviderUnavailableError("PaddleOCR worker timed out.") from exc

            if line is None:
                raise ProviderUnavailableError(self._worker_exit_detail())
            try:
                payload = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ProviderUnavailableError(
                    f"PaddleOCR worker returned invalid JSON: {line.strip()}"
                ) from exc
            if not isinstance(payload, dict):
                raise ProviderUnavailableError("PaddleOCR worker returned a non-object payload.")
            if payload.get("id") != job_id:
                raise ProviderUnavailableError("PaddleOCR worker returned a mismatched job id.")
            if not payload.get("ok"):
                error = str(payload.get("error") or "PaddleOCR worker failed.")
                raise ProviderUnavailableError(error)
            result = payload.get("result")
            if not isinstance(result, dict):
                raise ProviderUnavailableError("PaddleOCR worker returned a missing result.")
            return result

    def close(self) -> None:
        if self._process.poll() is not None:
            return
        try:
            if self._process.stdin is not None:
                self._process.stdin.close()
            self._process.terminate()
            self._process.wait(timeout=2)
        except Exception:
            self._process.kill()

    def _ensure_running(self) -> None:
        if self._process.poll() is not None:
            raise ProviderUnavailableError(self._worker_exit_detail())

    def _worker_exit_detail(self) -> str:
        detail = "PaddleOCR worker exited unexpectedly."
        stderr = "\n".join(self._stderr_lines).strip()
        if stderr:
            return f"{detail} {stderr}"
        return detail

    def _read_stdout(self) -> None:
        stdout = self._process.stdout
        if stdout is None:
            self._responses.put(None)
            return
        for line in stdout:
            self._responses.put(line)
        self._responses.put(None)

    def _read_stderr(self) -> None:
        stderr = self._process.stderr
        if stderr is None:
            return
        for line in stderr:
            stripped = line.strip()
            if stripped:
                self._stderr_lines.append(stripped)


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


def _ocr_result_from_payload(payload: dict[str, Any]) -> OCRPageResult:
    return OCRPageResult(
        text=str(payload.get("text") or ""),
        extraction_method=str(payload.get("extraction_method") or "paddle_ocr_cpu"),
        device=_optional_string(payload.get("device")),
        fallback_reason=_optional_string(payload.get("fallback_reason")),
        duration_ms=int(payload.get("duration_ms") or 0),
    )


def _write_prewarm_png() -> Path:
    with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as image_file:
        image_file.write(_prewarm_png())
        return Path(image_file.name)


def _prewarm_png() -> bytes:
    from io import BytesIO

    from PIL import Image, ImageDraw

    image = Image.new("RGB", (160, 56), "white")
    draw = ImageDraw.Draw(image)
    draw.text((8, 16), "OCR TEST", fill="black")
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _entrypoint_command(entrypoint: Path, args: list[str]) -> list[str]:
    if entrypoint.suffix.lower() in {".cmd", ".bat"}:
        return ["cmd.exe", "/C", str(entrypoint), *args]
    if entrypoint.suffix.lower() == ".ps1":
        return [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(entrypoint),
            *args,
        ]
    return [str(entrypoint), *args]


def serialize_ocr_health(health: OCRHealth) -> dict[str, Any]:
    return asdict(health)
