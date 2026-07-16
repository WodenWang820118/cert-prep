from __future__ import annotations

from dataclasses import dataclass
import logging
from pathlib import Path
import platform
import sys
import tempfile
from threading import Lock
from time import perf_counter
from types import ModuleType
from typing import Any

from cert_prep_ocr_windowsml.contracts import OCRHealth, OCRPageResult
from cert_prep_ocr_windowsml.device import (
    AUTO_WINDOWSML_DEVICE_ID,
    WindowsMLDeviceSelectionError,
    windowsml_device_label,
    resolve_windowsml_device_id,
)
from cert_prep_ocr_windowsml.exceptions import ProviderUnavailableError


WINDOWSML_IGPU_PROVIDER = "DmlExecutionProvider"
CPU_PROVIDER = "CPUExecutionProvider"
PADDLEOCR37_DET_MODEL_NAME = "PP-OCRv6_medium_det"
PADDLEOCR37_REC_MODEL_NAME = "PP-OCRv6_medium_rec"
PADDLEOCR37_REQUIRED_MODEL_FILES = (
    "det/inference.onnx",
    "det/inference.yml",
    "rec/inference.onnx",
    "rec/inference.yml",
    "rec/ppocr_keys_v1.txt",
    "pipeline.json",
)


logger = logging.getLogger(__name__)


class WindowsMLRuntimeOCRProvider:
    """Runnable WindowsML OCR provider used inside the packaged WindowsML runtime."""

    provider = "windowsml"
    engine = "paddleocr-3.7-onnxruntime-windowsml"
    page_workers = 1

    def __init__(
        self,
        *,
        model_dir: Path,
        device_id: int | None = AUTO_WINDOWSML_DEVICE_ID,
    ) -> None:
        self.model_dir = model_dir
        self.device_id = device_id
        self._cpu_fallback_warning_logged = False
        self._cpu_fallback_warning_lock = Lock()
        self._runner = WindowsMLOCRRunner(
            model_dir=model_dir,
            device_id=device_id,
        )

    def health(self) -> OCRHealth:
        providers, version, import_error = _onnxruntime_state()
        paddleocr_version, paddleocr_error = _paddleocr_state()
        cpu_available = CPU_PROVIDER in providers
        execution, execution_error = self._health_execution_selection(
            providers,
            import_error,
        )
        missing_files = [
            name
            for name in PADDLEOCR37_REQUIRED_MODEL_FILES
            if not (self.model_dir / name).is_file()
        ]
        available = (
            import_error is None
            and paddleocr_error is None
            and cpu_available
            and execution_error is None
            and not missing_files
        )
        fallback_reason = (
            execution.fallback_reason
            if available and execution is not None
            else None
        )
        if available:
            self._warn_cpu_fallback_once(fallback_reason)
        return OCRHealth(
            provider=self.provider,
            engine=self.engine,
            available=available,
            detail=_runtime_detail(
                import_error,
                paddleocr_error,
                cpu_available,
                missing_files,
                execution,
                execution_error,
            ),
            python_version=platform.python_version(),
            paddle_version=None,
            paddleocr_version=paddleocr_version or version,
            selected_device=(
                execution.selected_device if execution is not None else None
            ),
            cuda_available=False,
            gpu_count=0,
            model_cache_dir=str(self.model_dir),
            fallback_reason=fallback_reason,
            unavailable_reason=_runtime_unavailable_reason(
                import_error,
                paddleocr_error,
                cpu_available,
                missing_files,
                execution_error,
            ),
        )

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        try:
            result = self._runner.extract_text(image_png)
        except Exception:
            self._warn_cpu_fallback_once(self._runner.fallback_reason)
            raise
        self._warn_cpu_fallback_once(result.fallback_reason)
        return OCRPageResult(
            text=result.text,
            extraction_method="windowsml_ocr",
            device=result.device,
            fallback_reason=result.fallback_reason,
            duration_ms=result.duration_ms,
        )

    def _health_execution_selection(
        self,
        providers: list[str],
        import_error: Exception | None,
    ) -> tuple[_WindowsMLExecutionSelection | None, ProviderUnavailableError | None]:
        try:
            return (
                self._runner._execution_selection((providers, import_error)),
                None,
            )
        except ProviderUnavailableError as exc:
            return None, exc

    def _warn_cpu_fallback_once(self, fallback_reason: str | None) -> None:
        if fallback_reason is None:
            return
        with self._cpu_fallback_warning_lock:
            if self._cpu_fallback_warning_logged:
                return
            self._cpu_fallback_warning_logged = True
            logger.warning("WindowsML OCR acceleration warning: %s", fallback_reason)


@dataclass(frozen=True)
class WindowsMLOCRTextResult:
    text: str
    duration_ms: int
    box_count: int
    recognized_count: int
    device: str = "amd_windowsml"
    fallback_reason: str | None = None


@dataclass(frozen=True)
class _WindowsMLExecutionSelection:
    selected_device: str
    fallback_reason: str | None
    windowsml_device_id: int | None = None

    @property
    def uses_windowsml(self) -> bool:
        return self.fallback_reason is None


class WindowsMLOCRRunner:
    """PaddleOCR 3.7 ONNXRuntime runner using the WindowsML execution lane."""

    def __init__(
        self,
        *,
        model_dir: Path,
        device_id: int | None = AUTO_WINDOWSML_DEVICE_ID,
    ) -> None:
        self.model_dir = model_dir
        self.device_id = device_id
        self._execution: _WindowsMLExecutionSelection | None = None
        self._cpu_runtime_retry_attempted = False
        self._paddleocr: Any | None = None

    def extract_text(self, image_png: bytes) -> WindowsMLOCRTextResult:
        started = perf_counter()
        image_path = self._write_temp_png(image_png)
        try:
            results = self._predict_with_cpu_retry(str(image_path))
        finally:
            image_path.unlink(missing_ok=True)
        lines = _extract_paddleocr_texts(results)
        return WindowsMLOCRTextResult(
            text="\n".join(lines),
            duration_ms=_elapsed_ms(started),
            box_count=_count_paddleocr_boxes(results),
            recognized_count=len(lines),
            device=self._device_label(),
            fallback_reason=self._execution_selection().fallback_reason,
        )

    @property
    def fallback_reason(self) -> str | None:
        if self._execution is None:
            return None
        return self._execution.fallback_reason

    def _write_temp_png(self, image_png: bytes) -> Path:
        with tempfile.NamedTemporaryFile(
            prefix="cert-prep-windowsml-",
            suffix=".png",
            delete=False,
        ) as file:
            file.write(image_png)
        return Path(file.name)

    def _paddleocr_pipeline(self) -> Any:
        if self._paddleocr is None:
            PaddleOCR = _import_paddleocr()
            self._paddleocr = PaddleOCR(
                text_detection_model_name=PADDLEOCR37_DET_MODEL_NAME,
                text_detection_model_dir=str(self.model_dir / "det"),
                text_recognition_model_name=PADDLEOCR37_REC_MODEL_NAME,
                text_recognition_model_dir=str(self.model_dir / "rec"),
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                engine="onnxruntime",
                engine_config=self._engine_config(),
            )
        return self._paddleocr

    def _predict_with_cpu_retry(self, image_path: str) -> Any:
        try:
            pipeline = self._paddleocr_pipeline()
        except Exception as exc:
            if not self._switch_to_cpu_after_runtime_failure(
                exc,
                stage="pipeline initialization",
            ):
                raise
            return self._paddleocr_pipeline().predict(image_path)
        try:
            return pipeline.predict(image_path)
        except Exception as exc:
            if not self._switch_to_cpu_after_runtime_failure(
                exc,
                stage="prediction",
            ):
                raise
            return self._paddleocr_pipeline().predict(image_path)

    def _switch_to_cpu_after_runtime_failure(
        self,
        error: Exception,
        *,
        stage: str,
    ) -> bool:
        execution = self._execution
        if (
            execution is None
            or not execution.uses_windowsml
            or self._cpu_runtime_retry_attempted
        ):
            return False
        self._cpu_runtime_retry_attempted = True
        detail = str(error).strip()
        cause = f"WindowsML iGPU {stage} failed with {type(error).__name__}"
        if detail:
            cause = f"{cause}: {detail}"
        self._execution = _cpu_execution_selection(cause)
        self._paddleocr = None
        return True

    def _engine_config(self) -> dict[str, Any]:
        execution = self._execution_selection()
        providers = [CPU_PROVIDER]
        provider_options: list[dict[str, Any]] = [{}]
        if execution.uses_windowsml:
            providers = [WINDOWSML_IGPU_PROVIDER, CPU_PROVIDER]
            provider_options = [
                {"device_id": execution.windowsml_device_id},
                {},
            ]
        return {
            "providers": providers,
            "provider_options": provider_options,
            "enable_mem_pattern": False,
            "execution_mode": "sequential",
        }

    def _execution_selection(
        self,
        runtime_state: tuple[list[str], Exception | None] | None = None,
    ) -> _WindowsMLExecutionSelection:
        if self._execution is not None:
            return self._execution
        if runtime_state is None:
            providers, _version, import_error = _onnxruntime_state()
        else:
            providers, import_error = runtime_state
        self._execution = _select_execution(
            providers,
            import_error=import_error,
            requested_device_id=self.device_id,
        )
        return self._execution

    def _device_label(self) -> str:
        return self._execution_selection().selected_device


def _select_execution(
    providers: list[str],
    *,
    import_error: Exception | None,
    requested_device_id: int | None,
) -> _WindowsMLExecutionSelection:
    if import_error is not None:
        raise ProviderUnavailableError(
            f"ONNX Runtime provider discovery failed: {import_error}"
        ) from import_error
    if CPU_PROVIDER not in providers:
        raise ProviderUnavailableError(
            "WindowsML OCR requires CPUExecutionProvider, but it is unavailable."
        )
    if WINDOWSML_IGPU_PROVIDER not in providers:
        return _cpu_execution_selection("DmlExecutionProvider is unavailable")
    try:
        selected_device_id = resolve_windowsml_device_id(requested_device_id)
    except WindowsMLDeviceSelectionError as exc:
        return _cpu_execution_selection(
            f"AMD/DXGI adapter selection failed: {exc}"
        )
    return _WindowsMLExecutionSelection(
        selected_device=windowsml_device_label(selected_device_id),
        fallback_reason=None,
        windowsml_device_id=selected_device_id,
    )


def _cpu_execution_selection(cause: str) -> _WindowsMLExecutionSelection:
    return _WindowsMLExecutionSelection(
        selected_device="cpu",
        fallback_reason=(
            "WindowsML OCR acceleration could not be confirmed "
            f"because {cause}; using CPU OCR, which may be slower."
        ),
    )


def _onnxruntime_state() -> tuple[list[str], str | None, Exception | None]:
    try:
        import onnxruntime as ort  # type: ignore[import-not-found]
    except Exception as exc:
        return [], None, exc
    try:
        providers = list(ort.get_available_providers())
    except Exception as exc:
        return [], getattr(ort, "__version__", None), exc
    return providers, getattr(ort, "__version__", None), None


def _paddleocr_state() -> tuple[str | None, Exception | None]:
    _install_offline_aistudio_stubs()
    try:
        import paddleocr  # type: ignore[import-not-found]
    except Exception as exc:
        return None, exc
    return getattr(paddleocr, "__version__", None), None


def _import_paddleocr() -> Any:
    _install_offline_aistudio_stubs()
    try:
        from paddleocr import PaddleOCR  # type: ignore[import-not-found]
    except Exception as exc:
        raise ProviderUnavailableError(f"PaddleOCR 3.7 runtime unavailable: {exc}") from exc
    return PaddleOCR


def _install_offline_aistudio_stubs() -> None:
    """Keep PaddleX's optional AIStudio downloader out of the packaged runtime."""
    existing = sys.modules.get("aistudio_sdk")
    if getattr(existing, "_cert_prep_offline_stub", False):
        return

    package = ModuleType("aistudio_sdk")
    package.__path__ = []  # type: ignore[attr-defined]
    package._cert_prep_offline_stub = True  # type: ignore[attr-defined]
    errors = ModuleType("aistudio_sdk.errors")
    downloads = ModuleType("aistudio_sdk.snapshot_download")

    class NotExistError(Exception):
        pass

    def snapshot_download(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError(
            "Cert Prep's WindowsML OCR runtime only uses its bundled model files."
        )

    errors.NotExistError = NotExistError  # type: ignore[attr-defined]
    downloads.snapshot_download = snapshot_download  # type: ignore[attr-defined]
    package.errors = errors  # type: ignore[attr-defined]
    package.snapshot_download = downloads  # type: ignore[attr-defined]
    sys.modules["aistudio_sdk"] = package
    sys.modules["aistudio_sdk.errors"] = errors
    sys.modules["aistudio_sdk.snapshot_download"] = downloads


def _runtime_unavailable_reason(
    import_error: Exception | None,
    paddleocr_error: Exception | None,
    cpu_available: bool,
    missing_files: list[str],
    execution_error: Exception | None,
) -> str | None:
    if import_error is not None:
        return "windowsml_runtime_missing"
    if paddleocr_error is not None:
        return "paddleocr37_runtime_missing"
    if not cpu_available:
        return "cpu_provider_unavailable"
    if execution_error is not None:
        return "windowsml_runtime_unavailable"
    if missing_files:
        return "windowsml_model_artifacts_missing"
    return None


def _runtime_detail(
    import_error: Exception | None,
    paddleocr_error: Exception | None,
    cpu_available: bool,
    missing_files: list[str],
    execution: _WindowsMLExecutionSelection | None,
    execution_error: Exception | None,
) -> str:
    if import_error is not None:
        return f"WindowsML OCR runtime unavailable: {import_error}"
    if paddleocr_error is not None:
        return f"PaddleOCR 3.7 runtime unavailable: {paddleocr_error}"
    if not cpu_available:
        return "WindowsML OCR runtime is installed but CPUExecutionProvider is unavailable."
    if execution_error is not None:
        return f"WindowsML OCR runtime unavailable: {execution_error}"
    if missing_files:
        return f"WindowsML OCR model artifacts are missing: {', '.join(missing_files)}."
    if execution is not None and execution.fallback_reason is not None:
        return execution.fallback_reason
    return (
        "WindowsML OCR runtime is ready with PaddleOCR 3.7, PP-OCRv6 medium, "
        "WindowsML iGPU selection, and CPU fallback for unsupported operators."
    )


def _paddleocr_payloads(results: Any) -> list[dict[str, Any]]:
    payloads: list[dict[str, Any]] = []
    if results is None:
        return payloads
    sequence = results if isinstance(results, list | tuple) else [results]
    for result in sequence:
        data = getattr(result, "json", None)
        if not isinstance(data, dict):
            to_dict = getattr(result, "to_dict", None)
            data = to_dict() if callable(to_dict) else {}
        res = data.get("res", {}) if isinstance(data, dict) else {}
        if isinstance(res, dict):
            payloads.append(res)
    return payloads


def _extract_paddleocr_texts(results: Any) -> list[str]:
    texts: list[str] = []
    for payload in _paddleocr_payloads(results):
        rec_texts = payload.get("rec_texts", [])
        if isinstance(rec_texts, list):
            texts.extend(str(text) for text in rec_texts if str(text).strip())
    return texts


def _count_paddleocr_boxes(results: Any) -> int:
    count = 0
    for payload in _paddleocr_payloads(results):
        for key in ("dt_polys", "rec_boxes", "rec_polys"):
            boxes = payload.get(key)
            if isinstance(boxes, list):
                count += len(boxes)
                break
    return count


def _elapsed_ms(started_at: float) -> int:
    return max(0, round((perf_counter() - started_at) * 1000))
