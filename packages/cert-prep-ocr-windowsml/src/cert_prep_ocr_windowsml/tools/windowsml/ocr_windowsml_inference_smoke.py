from __future__ import annotations

import argparse
import csv
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from dataclasses import asdict
from io import BytesIO
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
from time import sleep
from time import perf_counter
from typing import Any

from cert_prep_ocr_windowsml.paths import DEFAULT_OUTPUT_DIR
from cert_prep_ocr_windowsml.runtime import WindowsMLRuntimeOCRProvider
from cert_prep_ocr_windowsml.tools.windowsml.ocr_windowsml_probe import DEFAULT_MODEL_DIR
from cert_prep_ocr_windowsml.tools.windowsml.ocr_windowsml_smoke import (
    WINDOWSML_DEVICE_LABEL,
    build_report as build_session_report,
)


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


InferenceRunner = Callable[[dict[str, Any]], dict[str, Any]]
DETERMINISTIC_TEXT = "OCRTEST"
DETERMINISTIC_IMAGE_SIZE = (640, 180)
GPU_TELEMETRY_INTERVAL_MS = 500
NVIDIA_DGPU_PROCESS_MEMORY_GATE_BYTES = 64 * 1024 * 1024


def default_output_path() -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return DEFAULT_OUTPUT_DIR / f"ocr-windowsml-inference-smoke-{stamp}.json"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=default_output_path())
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument(
        "--fail-if-not-inference-ready",
        action="store_true",
        help="Exit non-zero unless the deterministic WindowsML OCR inference gate passes.",
    )
    return parser.parse_args(argv)


def build_report(
    *,
    model_dir: Path = DEFAULT_MODEL_DIR,
    inference_runner: InferenceRunner | None = None,
) -> dict[str, Any]:
    session_report = build_session_report(model_dir=model_dir)
    inference_smoke = build_inference_smoke(
        session_report,
        inference_runner=inference_runner,
    )
    status = classify_inference_status(session_report["status"], inference_smoke)
    return {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "mode": {
            "name": "ocr_windowsml_inference_smoke",
            "goal": (
                "Run a deterministic PP-OCR ONNX inference on AMD WindowsML before "
                "allowing WindowsML OCR to become a production provider."
            ),
            "does_not_pull_models": True,
            "does_not_change_runtime_defaults": True,
        },
        "session_report": session_report,
        "windowsml_inference_smoke": inference_smoke,
        "status": status,
    }


def build_inference_smoke(
    session_report: dict[str, Any],
    *,
    inference_runner: InferenceRunner | None = None,
) -> dict[str, Any]:
    session_status = session_report.get("status", {})
    if session_status.get("state") != "session_ready":
        return {
            "state": "skipped",
            "reason": session_status.get("state") or "session_not_ready",
            "device": None,
            "text": "",
        }
    if inference_runner is None:
        return run_windowsml_recognition_smoke(session_report)
    return inference_runner(session_report)


def run_windowsml_recognition_smoke(session_report: dict[str, Any]) -> dict[str, Any]:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except Exception as exc:
        return failed_inference_smoke("windowsml_inference_import_failed", exc)

    model_dir = model_dir_from_session_report(session_report)
    if model_dir is None:
        return {
            "state": "skipped",
            "reason": "model_dir_missing",
            "device": "amd_windowsml",
            "text": "",
        }

    started = perf_counter()
    gpu_capture = WindowsGpuTelemetryCapture(
        output_dir=DEFAULT_OUTPUT_DIR / "gpu-telemetry",
        target_pid=os.getpid(),
    )
    try:
        gpu_capture.start()
        provider = WindowsMLRuntimeOCRProvider(
            model_dir=model_dir,
            device_id=windowsml_device_id(session_report),
        )
        image = create_deterministic_text_image(
            text=DETERMINISTIC_TEXT,
            image_class=Image,
            draw_class=ImageDraw,
            font_class=ImageFont,
        )
        result = provider.extract_page_text(image_to_png(image), 1)
    except Exception as exc:
        return failed_inference_smoke("windowsml_inference_failed", exc)
    finally:
        gpu_capture.stop()

    duration_ms = int((perf_counter() - started) * 1000)
    text = result.text.replace(" ", "").replace("\n", "")
    expected_text_matched = DETERMINISTIC_TEXT in text
    gpu_telemetry = gpu_capture.summary(
        dxgi_adapters=dxgi_adapters_from_session_report(session_report),
        target_luid=windowsml_adapter_luid(session_report),
    )
    return {
        "state": "passed" if expected_text_matched else "failed",
        "reason": None if expected_text_matched else "windowsml_inference_text_mismatch",
        "scope": "full_page_ocr",
        "model_dir": str(model_dir),
        "device": WINDOWSML_DEVICE_LABEL,
        "windowsml_device_id": windowsml_device_id(session_report),
        "expected_text": DETERMINISTIC_TEXT,
        "text": result.text,
        "expected_text_matched": expected_text_matched,
        "duration_ms": duration_ms,
        "provider_result": asdict(result),
        "gpu_telemetry": gpu_telemetry,
        "input_image_size": list(DETERMINISTIC_IMAGE_SIZE),
        "full_page_ocr_ready": True,
        "remaining_gate": (
            "pdf_page_latency"
            if gpu_telemetry.get("amd_igpu_compute_observed")
            else "gpu_compute_evidence"
        ),
    }


def failed_inference_smoke(reason: str, exc: Exception) -> dict[str, Any]:
    return {
        "state": "failed",
        "reason": reason,
        "error": str(exc),
        "device": WINDOWSML_DEVICE_LABEL,
        "text": "",
    }


def model_dir_from_session_report(session_report: dict[str, Any]) -> Path | None:
    probe = session_report.get("probe", {})
    artifacts = probe.get("model_artifacts", {})
    model_dir = artifacts.get("model_dir")
    return Path(str(model_dir)) if model_dir else None


def windowsml_device_id(session_report: dict[str, Any]) -> int | None:
    smoke = session_report.get("windowsml_session_smoke", {})
    raw = smoke.get("windowsml_device_id")
    return raw if isinstance(raw, int) and raw >= 0 else None


def create_deterministic_text_image(
    *,
    text: str,
    image_class: Any,
    draw_class: Any,
    font_class: Any,
) -> Any:
    image = image_class.new("RGB", DETERMINISTIC_IMAGE_SIZE, "white")
    draw = draw_class.Draw(image)
    draw.text((30, 40), text, font=load_test_font(font_class), fill="black")
    return image


def load_test_font(font_class: Any) -> Any:
    for font_path in (
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/meiryo.ttc",
    ):
        try:
            return font_class.truetype(font_path, 72)
        except Exception:
            continue
    return font_class.load_default()


def image_to_png(image: Any) -> bytes:
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


class WindowsGpuTelemetryCapture:
    def __init__(
        self,
        *,
        output_dir: Path,
        target_pid: int,
        interval_ms: int = GPU_TELEMETRY_INTERVAL_MS,
    ) -> None:
        self.output_dir = output_dir
        self.target_pid = target_pid
        self.interval_ms = interval_ms
        self.csv_path = self._csv_path()
        self._process: subprocess.Popen[bytes] | None = None
        self._start_error: str | None = None
        self._cleanup_report: dict[str, Any] | None = None

    def start(self) -> None:
        if platform.system().lower() != "windows":
            self._start_error = "windows_gpu_counters_require_windows"
            return
        self.output_dir.mkdir(parents=True, exist_ok=True)
        script = windows_gpu_telemetry_sampler_script(
            csv_path=self.csv_path,
            target_pid=self.target_pid,
            interval_ms=self.interval_ms,
        )
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            self._process = subprocess.Popen(
                [
                    powershell_executable(),
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    script,
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=creationflags,
            )
        except Exception as exc:
            self._start_error = str(exc)
            self._process = None
            return

        # Give PowerShell enough time to create the CSV header before OCR starts.
        sleep(0.3)

    def stop(self) -> dict[str, Any]:
        process = self._process
        self._process = None
        if process is None:
            self._cleanup_report = {
                "attempted": False,
                "reason": "sampler_not_started",
                "terminated": True,
            }
            return self._cleanup_report
        self._cleanup_report = terminate_sampler_process_tree(process)
        return self._cleanup_report

    def summary(
        self,
        *,
        dxgi_adapters: Sequence[dict[str, Any]],
        target_luid: str | None,
    ) -> dict[str, Any]:
        summary = summarize_process_gpu_telemetry(
            csv_path=self.csv_path,
            target_pid=self.target_pid,
            dxgi_adapters=dxgi_adapters,
            target_luid=target_luid,
        )
        if self._start_error:
            summary["start_error"] = self._start_error
        summary["sampler_cleanup"] = self._cleanup_report or {
            "attempted": False,
            "reason": "sampler_stop_not_called",
            "terminated": False,
        }
        return summary

    def _csv_path(self) -> Path:
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        return self.output_dir / (
            f"ocr-windowsml-inference-gpu-telemetry-{stamp}-pid{self.target_pid}.csv"
        )


def windows_gpu_telemetry_sampler_script(
    *,
    csv_path: Path,
    target_pid: int,
    interval_ms: int,
) -> str:
    return f"""$ErrorActionPreference = 'SilentlyContinue'
$csvPath = {powershell_single_quoted(str(csv_path))}
$targetPid = {target_pid}
$intervalMs = {interval_ms}
$counters = @(
  '\\GPU Process Memory(*)\\Dedicated Usage',
  '\\GPU Process Memory(*)\\Shared Usage',
  '\\GPU Process Memory(*)\\Total Committed',
  '\\GPU Engine(*)\\Utilization Percentage'
)
'timestamp,path,pid,luid,metric,value' | Set-Content -Path $csvPath -Encoding utf8
while ($true) {{
  $timestamp = (Get-Date).ToUniversalTime().ToString('o')
  $rows = @()
  try {{
    $samples = (Get-Counter -Counter $counters -ErrorAction Stop).CounterSamples
    foreach ($sample in $samples) {{
      $path = [string]$sample.Path
      if ($path -notmatch "pid_$targetPid") {{
        continue
      }}
      $pidMatch = [regex]::Match($path, 'pid_(\\d+)')
      $luidMatch = [regex]::Match($path, 'luid_(0x[0-9a-fA-F]{{8}}_0x[0-9a-fA-F]{{8}})')
      if (-not $pidMatch.Success -or -not $luidMatch.Success) {{
        continue
      }}
      $metric = if ($path -match 'Dedicated Usage') {{
        'dedicated_usage'
      }} elseif ($path -match 'Shared Usage') {{
        'shared_usage'
      }} elseif ($path -match 'Total Committed') {{
        'total_committed'
      }} elseif ($path -match 'Utilization Percentage') {{
        'engine_utilization_percent'
      }} else {{
        'unknown'
      }}
      $rows += [pscustomobject]@{{
        timestamp = $timestamp
        path = $path
        pid = $pidMatch.Groups[1].Value
        luid = $luidMatch.Groups[1].Value.ToLowerInvariant()
        metric = $metric
        value = [double]$sample.CookedValue
      }}
    }}
    if ($rows.Count -gt 0) {{
      $rows | ConvertTo-Csv -NoTypeInformation | Select-Object -Skip 1 |
        Add-Content -Path $csvPath -Encoding utf8
    }}
  }} catch {{
  }}
  Start-Sleep -Milliseconds $intervalMs
}}
"""


def powershell_single_quoted(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def powershell_executable() -> str:
    for name in ("powershell.exe", "powershell", "pwsh.exe", "pwsh"):
        path = shutil.which(name)
        if path:
            return path
    system_root = os.environ.get("SystemRoot")
    if system_root:
        candidate = Path(system_root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
        if candidate.is_file():
            return str(candidate)
    return "powershell.exe"


def terminate_sampler_process_tree(process: subprocess.Popen[bytes]) -> dict[str, Any]:
    pid = process.pid
    if process.poll() is not None:
        return {
            "attempted": False,
            "pid": pid,
            "reason": "sampler_already_exited",
            "terminated": True,
            "exit_code": process.returncode,
        }
    return terminate_windows_process_tree(process)


def terminate_windows_process_tree(process: subprocess.Popen[bytes]) -> dict[str, Any]:
    pid = process.pid
    try:
        taskkill = subprocess.run(
            [taskkill_executable(), "/PID", str(pid), "/T", "/F"],
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
    except Exception as exc:
        fallback = terminate_process(process)
        return {
            **fallback,
            "pid": pid,
            "method": "terminate_fallback_after_taskkill_error",
            "taskkill_error": str(exc),
        }

    exit_code = wait_for_process_exit(process, timeout_seconds=5)
    return {
        "attempted": True,
        "pid": pid,
        "method": "taskkill_process_tree",
        "terminated": process.poll() is not None,
        "exit_code": exit_code,
        "taskkill_exit_code": taskkill.returncode,
        "taskkill_stdout": taskkill.stdout.strip(),
        "taskkill_stderr": taskkill.stderr.strip(),
    }


def terminate_process(process: subprocess.Popen[bytes]) -> dict[str, Any]:
    pid = process.pid
    try:
        process.terminate()
        exit_code = wait_for_process_exit(process, timeout_seconds=5)
        if process.poll() is None:
            process.kill()
            exit_code = wait_for_process_exit(process, timeout_seconds=5)
    except Exception as exc:
        return {
            "attempted": True,
            "pid": pid,
            "method": "terminate_then_kill",
            "terminated": process.poll() is not None,
            "exit_code": process.returncode,
            "error": str(exc),
        }
    return {
        "attempted": True,
        "pid": pid,
        "method": "terminate_then_kill",
        "terminated": process.poll() is not None,
        "exit_code": exit_code,
    }


def wait_for_process_exit(
    process: subprocess.Popen[bytes],
    *,
    timeout_seconds: int,
) -> int | None:
    try:
        return process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        return None


def taskkill_executable() -> str:
    path = shutil.which("taskkill.exe") or shutil.which("taskkill")
    if path:
        return path
    system_root = os.environ.get("SystemRoot")
    if system_root:
        candidate = Path(system_root) / "System32" / "taskkill.exe"
        if candidate.is_file():
            return str(candidate)
    return "taskkill.exe"


def dxgi_adapters_from_session_report(session_report: dict[str, Any]) -> list[dict[str, Any]]:
    probe = session_report.get("probe", {})
    adapters = probe.get("dxgi_adapters", [])
    return [adapter for adapter in adapters if isinstance(adapter, dict)]


def windowsml_adapter_luid(session_report: dict[str, Any]) -> str | None:
    probe = session_report.get("probe", {})
    status = probe.get("status", {}) if isinstance(probe, dict) else {}
    selection = status.get("windowsml_device_selection", {}) if isinstance(status, dict) else {}
    adapter = selection.get("adapter", {}) if isinstance(selection, dict) else {}
    luid = adapter.get("luid") if isinstance(adapter, dict) else None
    return normalize_luid(str(luid)) if luid else None


def summarize_process_gpu_telemetry(
    *,
    csv_path: Path,
    target_pid: int,
    dxgi_adapters: Sequence[dict[str, Any]],
    target_luid: str | None,
) -> dict[str, Any]:
    adapter_kinds = adapter_kinds_by_luid(dxgi_adapters)
    rows = load_gpu_telemetry_rows(csv_path, target_pid=target_pid)
    amd_luid = normalize_luid(target_luid or "")
    amd_rows = [
        row
        for row in rows
        if row["luid"] == amd_luid
        or (not amd_luid and adapter_kinds.get(row["luid"]) == "amd_igpu")
    ]
    nvidia_rows = [row for row in rows if adapter_kinds.get(row["luid"]) == "nvidia_dgpu"]
    amd_process_memory_max = max_metric(
        amd_rows,
        ("dedicated_usage", "shared_usage", "total_committed"),
    )
    nvidia_process_memory_max = max_metric(
        nvidia_rows,
        ("dedicated_usage", "shared_usage", "total_committed"),
    )
    amd_engine_max = max_metric(amd_rows, ("engine_utilization_percent",))
    nvidia_engine_max = max_metric(nvidia_rows, ("engine_utilization_percent",))
    amd_process_memory_observed = amd_process_memory_max > 0
    amd_compute_observed = amd_engine_max > 0
    nvidia_above_gate_observed = (
        nvidia_process_memory_max > NVIDIA_DGPU_PROCESS_MEMORY_GATE_BYTES
        or nvidia_engine_max > 0
    )
    return {
        "available": bool(rows),
        "csv_file": str(csv_path),
        "target_pid": target_pid,
        "target_adapter_luid": amd_luid or None,
        "sample_count": len(rows),
        "amd_igpu_resource_observed": amd_process_memory_observed or amd_compute_observed,
        "amd_igpu_process_memory_observed": amd_process_memory_observed,
        "amd_igpu_compute_observed": amd_compute_observed,
        "amd_igpu_process_memory_max_bytes": round(amd_process_memory_max),
        "amd_igpu_engine_utilization_percent_max": round(amd_engine_max, 3),
        "nvidia_dgpu_above_gate_observed": nvidia_above_gate_observed,
        "nvidia_dgpu_process_memory_max_bytes": round(nvidia_process_memory_max),
        "nvidia_dgpu_process_memory_gate_bytes": NVIDIA_DGPU_PROCESS_MEMORY_GATE_BYTES,
        "nvidia_dgpu_engine_utilization_percent_max": round(nvidia_engine_max, 3),
        "adapter_kinds_by_luid": adapter_kinds,
    }


def adapter_kinds_by_luid(dxgi_adapters: Sequence[dict[str, Any]]) -> dict[str, str]:
    result: dict[str, str] = {}
    for adapter in dxgi_adapters:
        luid = normalize_luid(str(adapter.get("luid") or ""))
        kind = str(adapter.get("adapter_kind") or "")
        if luid and kind:
            result[luid] = kind
    return result


def load_gpu_telemetry_rows(
    csv_path: Path,
    *,
    target_pid: int,
) -> list[dict[str, Any]]:
    if not csv_path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    try:
        with csv_path.open("r", encoding="utf-8-sig", newline="") as file:
            for row in csv.DictReader(file):
                if str(row.get("pid") or "") != str(target_pid):
                    continue
                value = parse_float(row.get("value"))
                if value is None:
                    continue
                metric = str(row.get("metric") or "")
                if metric == "engine_utilization_percent" and not 0 <= value <= 100:
                    continue
                rows.append(
                    {
                        "luid": normalize_luid(str(row.get("luid") or "")),
                        "metric": metric,
                        "value": value,
                    }
                )
    except Exception:
        return []
    return rows


def parse_float(value: Any) -> float | None:
    try:
        parsed = float(str(value))
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def max_metric(rows: Sequence[dict[str, Any]], metrics: Sequence[str]) -> float:
    selected = [
        float(row["value"])
        for row in rows
        if row.get("metric") in metrics and isinstance(row.get("value"), int | float)
    ]
    return max(selected, default=0.0)


def normalize_luid(value: str) -> str:
    match = re.search(r"0x[0-9a-fA-F]{8}_0x[0-9a-fA-F]{8}", value)
    return match.group(0).lower() if match else ""


def classify_inference_status(
    session_status: dict[str, Any],
    inference_smoke: dict[str, Any],
) -> dict[str, Any]:
    blockers = list(session_status.get("blockers", []))
    inference_state = str(inference_smoke.get("state") or "unknown")
    text = str(inference_smoke.get("text") or "").strip()
    device = str(inference_smoke.get("device") or "")
    expected_text = str(inference_smoke.get("expected_text") or "")
    expected_text_matched = (
        bool(inference_smoke.get("expected_text_matched"))
        if expected_text
        else bool(text)
    )
    gpu_telemetry = inference_smoke.get("gpu_telemetry", {})
    gpu_telemetry_available = isinstance(gpu_telemetry, dict) and bool(
        gpu_telemetry.get("available")
    )
    igpu_resource_observed = isinstance(gpu_telemetry, dict) and bool(
        gpu_telemetry.get("amd_igpu_resource_observed")
    )
    igpu_process_memory_observed = isinstance(gpu_telemetry, dict) and bool(
        gpu_telemetry.get("amd_igpu_process_memory_observed")
    )
    igpu_compute_observed = isinstance(gpu_telemetry, dict) and bool(
        gpu_telemetry.get("amd_igpu_compute_observed")
    )
    nvidia_dgpu_above_gate_observed = isinstance(gpu_telemetry, dict) and bool(
        gpu_telemetry.get("nvidia_dgpu_above_gate_observed")
    )

    if inference_state == "blocked":
        blockers.append(str(inference_smoke.get("reason") or "windowsml_inference_blocked"))
    elif inference_state == "failed":
        blockers.append(str(inference_smoke.get("reason") or "windowsml_inference_failed"))

    inference_ready = (
        inference_state == "passed"
        and bool(text)
        and device == WINDOWSML_DEVICE_LABEL
        and expected_text_matched
    )
    if inference_ready:
        state = "inference_ready"
    elif session_status.get("state") == "session_ready":
        state = "blocked"
    else:
        state = session_status.get("state") or "ready_for_model"

    return {
        "state": state,
        "blockers": blockers,
        "session_ready": bool(session_status.get("session_ready")),
        "inference_ready": inference_ready,
        "recognition_model_ready": inference_ready,
        "full_page_ocr_ready": bool(inference_smoke.get("full_page_ocr_ready")),
        "gpu_telemetry_available": gpu_telemetry_available,
        "igpu_resource_observed": igpu_resource_observed,
        "igpu_process_memory_observed": igpu_process_memory_observed,
        "igpu_compute_observed": igpu_compute_observed,
        "nvidia_dgpu_above_gate_observed": nvidia_dgpu_above_gate_observed,
        "device": device or None,
        "non_empty_text": bool(text),
        "current_safe_action": (
            "Keep WindowsML OCR behind the production gate until deterministic "
            "inference, full-page latency, and GPU routing evidence pass."
        ),
    }


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    report = build_report(model_dir=args.model_dir)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))

    if args.fail_if_not_inference_ready and report["status"]["state"] != "inference_ready":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
