from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from io import BytesIO
import atexit
import json
from pathlib import Path
import tempfile
from time import perf_counter
from typing import Any


NPU_PREPASS_MODEL_FILE = "npu-prepass/text-density.onnx"
NPU_PREPASS_MODEL_NAME = "text_density"
VITISAI_PROVIDER = "VitisAIExecutionProvider"
CPU_PROVIDER = "CPUExecutionProvider"
NPU_PREPASS_POLICIES = frozenset(
    {
        "MAX_EFFICIENCY",
        "MIN_OVERALL_POWER",
        "PREFER_NPU",
    }
)
_WINDOWSML_BOOTSTRAP_SHUTDOWN: Any | None = None
_WINDOWSML_BOOTSTRAP_ATEXIT_REGISTERED = False


@dataclass(frozen=True)
class NpuPrepassEvidence:
    attempted: bool
    available: bool
    model_name: str
    policy: str
    provider_counts: dict[str, int]
    duration_ms: int
    profile_file: str | None = None
    reason: str | None = None

    @property
    def vitisai_events(self) -> int:
        return self.provider_counts.get(VITISAI_PROVIDER, 0)

    @property
    def cpu_events(self) -> int:
        return self.provider_counts.get(CPU_PROVIDER, 0)

    def fallback_reason_fragment(self) -> str | None:
        if self.available and self.vitisai_events > 0:
            return (
                f"npu_prepass={self.model_name}_vitisai;"
                f"vitisai_events={self.vitisai_events};cpu_events={self.cpu_events}"
            )
        if self.attempted:
            reason = self.reason or "vitisai_events_missing"
            return (
                f"npu_prepass_unavailable={reason};"
                f"vitisai_events={self.vitisai_events};cpu_events={self.cpu_events}"
            )
        return None


class WindowsMLNpuPrepass:
    """Small WindowsML NPU evidence prepass run before full PaddleOCR det/rec."""

    def __init__(
        self,
        *,
        model_dir: Path,
        device_policy: str,
    ) -> None:
        self.model_dir = model_dir
        self.device_policy = device_policy.strip().upper() or "PREFER_NPU"

    def run(self, image_png: bytes) -> NpuPrepassEvidence:
        started = perf_counter()
        if self.device_policy not in NPU_PREPASS_POLICIES:
            return self._unavailable(
                started,
                attempted=False,
                reason="npu_prepass_policy_not_requested",
            )

        model_path = self.model_dir / NPU_PREPASS_MODEL_FILE
        if not model_path.is_file():
            return self._unavailable(
                started,
                attempted=False,
                reason="npu_prepass_model_missing",
            )

        try:
            session = self._prepass_session(model_path)
            feed = build_text_density_feed(session, image_png)
            session.run(None, feed)
            profile_path = end_session_profiling(session)
            provider_counts = (
                summarize_profile_provider_counts(profile_path)
                if profile_path is not None
                else {}
            )
        except Exception as exc:
            return self._unavailable(started, attempted=True, reason=compact_reason(exc))

        vitisai_events = provider_counts.get(VITISAI_PROVIDER, 0)
        return NpuPrepassEvidence(
            attempted=True,
            available=vitisai_events > 0,
            model_name=NPU_PREPASS_MODEL_NAME,
            policy=self.device_policy,
            provider_counts=provider_counts,
            profile_file=str(profile_path) if profile_path is not None else None,
            duration_ms=elapsed_ms(started),
            reason=None if vitisai_events > 0 else "vitisai_events_missing",
        )

    def _prepass_session(self, model_path: Path) -> Any:
        import onnxruntime as ort  # type: ignore[import-not-found]

        _ensure_windowsml_execution_providers()
        options = ort.SessionOptions()
        options.enable_mem_pattern = False
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.enable_profiling = True
        try:
            options.profile_file_prefix = str(_profile_file_prefix(self.model_dir))
        except Exception:
            pass
        providers = npu_prepass_providers(ort, options, self.device_policy)
        session_kwargs: dict[str, Any] = {"sess_options": options}
        if providers is not None:
            session_kwargs["providers"] = providers
        return ort.InferenceSession(str(model_path), **session_kwargs)

    def _unavailable(
        self,
        started: float,
        *,
        attempted: bool,
        reason: str,
        provider_counts: dict[str, int] | None = None,
    ) -> NpuPrepassEvidence:
        return NpuPrepassEvidence(
            attempted=attempted,
            available=False,
            model_name=NPU_PREPASS_MODEL_NAME,
            policy=self.device_policy,
            provider_counts=provider_counts or {},
            duration_ms=elapsed_ms(started),
            reason=reason,
        )


def npu_prepass_providers(ort: Any, options: Any, device_policy: str) -> list[str] | None:
    available_providers = set(_safe_provider_list(ort))
    if VITISAI_PROVIDER in available_providers:
        return [VITISAI_PROVIDER, CPU_PROVIDER]

    policy_setter = getattr(options, "set_provider_selection_policy", None)
    if callable(policy_setter):
        policy_setter(ort_execution_provider_policy(ort, device_policy))
        return None

    raise RuntimeError("VitisAIExecutionProvider unavailable for WindowsML NPU prepass")


def build_text_density_feed(session: Any, image_png: bytes) -> dict[str, Any]:
    import numpy as np
    from PIL import Image

    inputs = list(session.get_inputs())
    if not inputs:
        return {}
    input_name = str(getattr(inputs[0], "name", "image") or "image")
    image = Image.open(BytesIO(image_png)).convert("RGB").resize((32, 32))
    array = np.asarray(image, dtype=np.float32) / 255.0
    normalized = np.transpose(array, (2, 0, 1))[None, :, :, :]
    return {input_name: normalized.astype(np.float32, copy=False)}


def end_session_profiling(session: Any) -> Path | None:
    end_profiling = getattr(session, "end_profiling", None)
    if not callable(end_profiling):
        return None
    resolved_path = end_profiling()
    if not resolved_path:
        return None
    return Path(str(resolved_path))


def summarize_profile_provider_counts(profile_path: Path) -> dict[str, int]:
    payload = json.loads(profile_path.read_text(encoding="utf-8"))
    events = payload if isinstance(payload, list) else []
    counts = Counter(
        provider
        for provider in (_provider_from_profile_event(event) for event in events)
        if provider
    )
    return {
        provider: counts[provider]
        for provider in (VITISAI_PROVIDER, CPU_PROVIDER, "DmlExecutionProvider")
        if counts[provider] > 0
    }


def merge_fallback_reason_with_npu_prepass(
    fallback_reason: str | None,
    evidence: NpuPrepassEvidence,
) -> str | None:
    fragment = evidence.fallback_reason_fragment()
    if fragment is None:
        return fallback_reason
    if not fallback_reason:
        return fragment
    return f"{fallback_reason}; {fragment}"


def _provider_from_profile_event(event: Any) -> str:
    if not isinstance(event, dict):
        return ""
    args = event.get("args")
    candidates: list[str] = []
    if isinstance(args, dict):
        candidates.extend(str(value) for value in args.values() if isinstance(value, str))
    for key in ("name", "cat", "ph"):
        value = event.get(key)
        if isinstance(value, str):
            candidates.append(value)
    for candidate in candidates:
        provider = _normalize_provider_name(candidate)
        if provider:
            return provider
    return ""


def _normalize_provider_name(value: str) -> str:
    lowered = value.lower()
    if "vitisai" in lowered:
        return VITISAI_PROVIDER
    if "cpuexecutionprovider" in lowered:
        return CPU_PROVIDER
    if "dmlexecutionprovider" in lowered:
        return "DmlExecutionProvider"
    if value in {VITISAI_PROVIDER, CPU_PROVIDER, "DmlExecutionProvider"}:
        return value
    return ""


def _safe_provider_list(ort: Any) -> list[str]:
    try:
        return list(ort.get_available_providers())
    except Exception:
        return []


def _ensure_windowsml_execution_providers() -> None:
    global _WINDOWSML_BOOTSTRAP_ATEXIT_REGISTERED, _WINDOWSML_BOOTSTRAP_SHUTDOWN

    try:
        from winui3.microsoft.windows.ai import machinelearning as winml
        from winui3.microsoft.windows.applicationmodel.dynamicdependency import (
            bootstrap,
        )
    except Exception:
        return

    if _WINDOWSML_BOOTSTRAP_SHUTDOWN is None:
        try:
            options = bootstrap.InitializeOptions.ON_NO_MATCH_SHOW_UI
            _WINDOWSML_BOOTSTRAP_SHUTDOWN = bootstrap.initialize(options=options)
            if not _WINDOWSML_BOOTSTRAP_ATEXIT_REGISTERED:
                atexit.register(_shutdown_windowsml_bootstrap)
                _WINDOWSML_BOOTSTRAP_ATEXIT_REGISTERED = True
        except Exception:
            return

    try:
        catalog = winml.ExecutionProviderCatalog.get_default()
        for provider in _catalog_providers(catalog):
            if getattr(provider, "name", "") == VITISAI_PROVIDER:
                _await_windows_async(provider.ensure_ready_async())
        _register_windowsml_execution_providers(catalog)
    except Exception:
        return


def _catalog_providers(catalog: Any) -> list[Any]:
    try:
        providers = catalog.find_all_providers()
    except Exception:
        return []
    try:
        return list(providers) if isinstance(providers, (list, tuple)) else list(providers)
    except TypeError:
        return []


def _register_windowsml_execution_providers(catalog: Any) -> Any:
    for method_name in (
        "ensure_and_register_certified_async",
        "ensure_and_register_all_async",
        "register_certified_async",
    ):
        method = getattr(catalog, method_name, None)
        if callable(method):
            return _await_windows_async(method())
    return None


def _await_windows_async(operation: Any) -> Any:
    for method_name in ("get", "GetResults"):
        method = getattr(operation, method_name, None)
        if callable(method):
            return method()
    return operation


def _shutdown_windowsml_bootstrap() -> None:
    global _WINDOWSML_BOOTSTRAP_SHUTDOWN

    shutdown = _WINDOWSML_BOOTSTRAP_SHUTDOWN
    _WINDOWSML_BOOTSTRAP_SHUTDOWN = None
    exit_method = getattr(shutdown, "__exit__", None)
    if callable(exit_method):
        exit_method(None, None, None)


def _profile_file_prefix(model_dir: Path) -> Path:
    preferred_dir = model_dir.parent / "onnxruntime-profiles"
    try:
        preferred_dir.mkdir(parents=True, exist_ok=True)
        return preferred_dir / "npu-prepass"
    except OSError:
        fallback_dir = Path(tempfile.gettempdir()) / "cert-prep-onnxruntime-profiles"
        fallback_dir.mkdir(parents=True, exist_ok=True)
        return fallback_dir / "npu-prepass"


def compact_reason(error: Exception) -> str:
    text = " ".join(str(error).strip().split())
    text = text.replace(";", ",")
    return text[:160] or type(error).__name__


def ort_execution_provider_policy(ort: Any, device_policy: str) -> Any:
    policy_enum = getattr(ort, "OrtExecutionProviderDevicePolicy", None)
    if policy_enum is None:
        return device_policy
    return getattr(policy_enum, device_policy, policy_enum.PREFER_NPU)


def elapsed_ms(started_at: float) -> int:
    return max(0, round((perf_counter() - started_at) * 1000))
