from __future__ import annotations

import argparse
from collections.abc import Sequence
import csv
from datetime import UTC, datetime
import json
import os
from pathlib import Path
import platform
from time import perf_counter, sleep
from typing import Any
import subprocess

import ollama


BACKEND_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = BACKEND_ROOT / ".benchmarks"
DEFAULT_MODELS = ("qwen3.5:4b", "deepseek-r1:14b", "gemma4:12b")
DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434"
MEMORY_SMOKE_OPTIONS = {"temperature": 0, "num_ctx": 8192, "num_predict": 64}
OBSERVATION_COMMAND_TIMEOUT_SECONDS = 10.0
IDLE_SAMPLE_DELAY_SECONDS = 2.0

WINDOWS_GPU_COUNTERS = (
    r"\GPU Adapter Memory(*)\Dedicated Usage",
    r"\GPU Adapter Memory(*)\Shared Usage",
    r"\GPU Engine(*)\Utilization Percentage",
    r"\GPU Process Memory(*)\Dedicated Usage",
    r"\GPU Process Memory(*)\Shared Usage",
)


def default_output_path() -> Path:
    """Return the timestamped default memory report path."""
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return DEFAULT_OUTPUT_DIR / f"reasoning-memory-{stamp}.json"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=default_output_path())
    parser.add_argument("--model", action="append", dest="models")
    parser.add_argument(
        "--host",
        default=os.environ.get("EXAM_PREP_OLLAMA_HOST", DEFAULT_OLLAMA_HOST),
    )
    parser.add_argument("--timeout-seconds", type=float, default=180.0)
    return parser.parse_args(argv)


def build_report(
    *,
    models: Sequence[str],
    host: str,
    timeout_seconds: float,
) -> dict[str, object]:
    generated_at = datetime.now(UTC).isoformat()
    client = ollama.Client(host=host, timeout=timeout_seconds)

    local_ollama_list = _ollama_cli_snapshot(("list",), host)
    api_list = _ollama_api_list(client)
    available_models = set(api_list["model_names"])
    if not available_models:
        available_models.update(local_ollama_list.get("parsed_model_names", []))

    metadata: dict[str, object] = {
        "generated_at": generated_at,
        "host": host,
        "requested_models": list(models),
        "local_ollama_list": local_ollama_list,
        "ollama_api_list": api_list,
        "ollama_ps_before": _ollama_cli_snapshot(("ps",), host),
        "windows_gpu_counter_availability": sample_windows_gpu_counters(),
    }

    results = [
        observe_model_memory(
            client=client,
            model=model,
            available_models=available_models,
            host=host,
            timeout_seconds=timeout_seconds,
            model_list_available=api_list["available"] or local_ollama_list["available"],
            model_list_error=api_list.get("error") or local_ollama_list.get("error"),
        )
        for model in models
    ]
    metadata["ollama_ps_after"] = _ollama_cli_snapshot(("ps",), host)

    return {
        "schema_version": 1,
        "generated_at": generated_at,
        "host": host,
        "requested_models": list(models),
        "mode": {
            "name": "memory_smoke",
            "description": (
                "Tiny Ollama request for RAM/VRAM observation only; this is not a "
                "reasoning bakeoff or quality benchmark."
            ),
            "does_not_pull_models": True,
            "missing_models_are_blockers": True,
            "options": MEMORY_SMOKE_OPTIONS,
        },
        "metadata": metadata,
        "models": results,
    }


def observe_model_memory(
    *,
    client: ollama.Client,
    model: str,
    available_models: set[str],
    host: str,
    timeout_seconds: float,
    model_list_available: bool,
    model_list_error: object | None,
) -> dict[str, object]:
    if not model_list_available:
        return {
            "model": model,
            "provider": "ollama",
            "status": "request_failed",
            "stage": "list_models",
            "error": model_list_error
            or {"type": "ModelListUnavailable", "message": "Unable to list Ollama models."},
            "observations": [],
        }

    if model not in available_models:
        return {
            "model": model,
            "provider": "ollama",
            "status": "missing_model",
            "blocker": True,
            "detail": "Model is not installed locally; memory smoke skipped without pulling.",
            "observations": [],
        }

    observations = [sample_observation("before", host)]
    started_at = perf_counter()
    chunk_count = 0
    response_chars = 0
    sampled_load = False
    sampled_run = False

    try:
        stream = client.chat(
            model=model,
            messages=memory_smoke_messages(),
            options=MEMORY_SMOKE_OPTIONS,
            think=False,
            stream=True,
            keep_alive="2m",
        )
        for chunk in stream:
            chunk_count += 1
            response_chars += len(_response_content(chunk))
            if not sampled_load:
                observations.append(sample_observation("load", host))
                sampled_load = True
            elif not sampled_run and chunk_count >= 3:
                observations.append(sample_observation("run", host))
                sampled_run = True

        latency_ms = round((perf_counter() - started_at) * 1000)
        if not sampled_load:
            observations.append(sample_observation("load", host))
        if not sampled_run:
            observations.append(sample_observation("run", host))
        sleep(IDLE_SAMPLE_DELAY_SECONDS)
        observations.append(sample_observation("idle", host))
        return {
            "model": model,
            "provider": "ollama",
            "status": "completed",
            "latency_ms": latency_ms,
            "request": {
                "kind": "memory_smoke",
                "not_bakeoff": True,
                "options": MEMORY_SMOKE_OPTIONS,
            },
            "response": {
                "stream_chunks": chunk_count,
                "content_chars": response_chars,
            },
            "observations": observations,
        }
    except Exception as exc:
        if not sampled_load:
            observations.append(sample_observation("load", host))
        sleep(IDLE_SAMPLE_DELAY_SECONDS)
        observations.append(sample_observation("idle", host))
        return {
            "model": model,
            "provider": "ollama",
            "status": "request_failed",
            "stage": "chat",
            "latency_ms": round((perf_counter() - started_at) * 1000),
            "request": {
                "kind": "memory_smoke",
                "not_bakeoff": True,
                "options": MEMORY_SMOKE_OPTIONS,
            },
            "error": {"type": type(exc).__name__, "message": str(exc)},
            "observations": observations,
        }


def memory_smoke_messages() -> list[dict[str, str]]:
    return [
        {
            "role": "system",
            "content": (
                "You are running a tiny memory smoke for a local exam-prep tool. "
                "Do not solve an exam, do not include hidden reasoning, and reply briefly."
            ),
        },
        {
            "role": "user",
            "content": "Reply with one short sentence confirming the memory smoke ran.",
        },
    ]


def sample_observation(stage: str, host: str) -> dict[str, object]:
    return {
        "stage": stage,
        "captured_at": datetime.now(UTC).isoformat(),
        "ollama_ps": _ollama_cli_snapshot(("ps",), host),
        "ollama_processes": sample_ollama_processes(),
        "windows_gpu_counters": sample_windows_gpu_counters(),
        "nvidia_smi": sample_nvidia_smi(),
    }


def sample_ollama_processes() -> dict[str, object]:
    if platform.system() == "Windows":
        result = _run_command(
            ("tasklist.exe", "/FO", "CSV", "/NH"),
            OBSERVATION_COMMAND_TIMEOUT_SECONDS,
        )
        return {
            "available": result["available"],
            "platform": "Windows",
            "processes": _parse_tasklist_processes(str(result.get("stdout", ""))),
            "command": _without_stdout(result),
        }

    result = _run_command(("ps", "-eo", "pid=,rss=,comm=,args="), OBSERVATION_COMMAND_TIMEOUT_SECONDS)
    processes: list[dict[str, object]] = []
    if result["available"]:
        for line in str(result.get("stdout", "")).splitlines():
            if "ollama" not in line.lower() and "llama" not in line.lower():
                continue
            parts = line.strip().split(None, 3)
            if len(parts) < 3:
                continue
            processes.append(
                {
                    "pid": _int_or_none(parts[0]),
                    "rss_bytes": _rss_kib_to_bytes(parts[1]),
                    "name": parts[2],
                    "command_line": parts[3] if len(parts) > 3 else "",
                }
            )
    return {
        "available": result["available"],
        "platform": platform.system(),
        "processes": processes,
        "command": _without_stdout(result),
    }


def sample_windows_gpu_counters() -> dict[str, object]:
    if platform.system() != "Windows":
        return {
            "available": False,
            "platform": platform.system(),
            "reason": "not_windows",
            "counters": list(WINDOWS_GPU_COUNTERS),
        }

    result = _run_command(
        ("typeperf.exe", *WINDOWS_GPU_COUNTERS, "-sc", "1"),
        OBSERVATION_COMMAND_TIMEOUT_SECONDS,
    )
    samples = _parse_typeperf_samples(str(result.get("stdout", "")))
    return {
        "available": result["available"],
        "platform": "Windows",
        "counters": list(WINDOWS_GPU_COUNTERS),
        "samples": samples,
        "command": _without_stdout(result),
    }


def sample_nvidia_smi() -> dict[str, object]:
    return _run_command(("nvidia-smi",), OBSERVATION_COMMAND_TIMEOUT_SECONDS)


def _ollama_api_list(client: ollama.Client) -> dict[str, object]:
    try:
        response = client.list()
    except Exception as exc:
        return {
            "available": False,
            "model_names": [],
            "error": {"type": type(exc).__name__, "message": str(exc)},
        }
    return {
        "available": True,
        "model_names": sorted(model_names_from_ollama_list_response(response)),
        "raw": _jsonable(response),
    }


def _ollama_cli_snapshot(args: Sequence[str], host: str) -> dict[str, object]:
    result = _run_command(("ollama", *args), OBSERVATION_COMMAND_TIMEOUT_SECONDS, host=host)
    if tuple(args) == ("list",):
        result["parsed_model_names"] = model_names_from_ollama_list_stdout(
            str(result.get("stdout", ""))
        )
    return result


def _run_command(
    command: Sequence[str],
    timeout_seconds: float,
    *,
    host: str | None = None,
) -> dict[str, object]:
    env = os.environ.copy()
    if host is not None:
        env["OLLAMA_HOST"] = host
    started_at = perf_counter()
    try:
        completed = subprocess.run(
            list(command),
            capture_output=True,
            check=False,
            encoding="utf-8",
            errors="replace",
            env=env,
            text=True,
            timeout=timeout_seconds,
        )
    except FileNotFoundError as exc:
        return {
            "available": False,
            "command": list(command),
            "elapsed_ms": round((perf_counter() - started_at) * 1000),
            "error": {"type": type(exc).__name__, "message": str(exc)},
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "available": False,
            "command": list(command),
            "elapsed_ms": round((perf_counter() - started_at) * 1000),
            "error": {"type": type(exc).__name__, "message": str(exc)},
            "stdout": exc.stdout or "",
            "stderr": exc.stderr or "",
        }

    return {
        "available": completed.returncode == 0,
        "command": list(command),
        "exit_code": completed.returncode,
        "elapsed_ms": round((perf_counter() - started_at) * 1000),
        "stdout": completed.stdout,
        "stderr": completed.stderr,
    }


def _without_stdout(result: dict[str, object]) -> dict[str, object]:
    return {key: value for key, value in result.items() if key != "stdout"}


def _parse_tasklist_processes(stdout: str) -> list[dict[str, object]]:
    processes: list[dict[str, object]] = []
    for row in csv.reader(stdout.splitlines()):
        if len(row) < 5:
            continue
        name = row[0]
        if not _looks_like_ollama_process(name):
            continue
        processes.append(
            {
                "name": name,
                "pid": _int_or_none(row[1]),
                "rss_bytes": _windows_mem_usage_to_bytes(row[4]),
            }
        )
    return processes


def _parse_typeperf_samples(stdout: str) -> list[dict[str, object]]:
    rows = [row for row in csv.reader(stdout.splitlines()) if len(row) > 1]
    headers = next((row for row in rows if row[0].startswith("(PDH-CSV")), None)
    values = next((row for row in rows if not row[0].startswith("(PDH-CSV")), None)
    if headers is None or values is None:
        return []

    samples: list[dict[str, object]] = []
    for path, raw_value in zip(headers[1:], values[1:], strict=False):
        value = _float_or_none(raw_value)
        if value is None:
            continue
        if value == 0 and "GPU Adapter Memory" not in path:
            continue
        samples.append({"path": path, "value": value})
        if len(samples) >= 120:
            break
    return samples


def _looks_like_ollama_process(name: str) -> bool:
    normalized = name.lower()
    return "ollama" in normalized or "llama" in normalized or "runner" in normalized


def model_names_from_ollama_list_response(response: Any) -> set[str]:
    models = getattr(response, "models", None)
    if models is None and isinstance(response, dict):
        models = response.get("models", [])
    names: set[str] = set()
    for model in models or []:
        name = getattr(model, "model", None)
        if name is None:
            name = getattr(model, "name", None)
        if name is None and isinstance(model, dict):
            name = model.get("model") or model.get("name")
        if isinstance(name, str):
            names.add(name)
    return names


def model_names_from_ollama_list_stdout(stdout: str) -> list[str]:
    names: list[str] = []
    for line in stdout.splitlines():
        stripped = line.strip()
        if not stripped or stripped.upper().startswith("NAME "):
            continue
        names.append(stripped.split()[0])
    return sorted(names)


def _response_content(response: Any) -> str:
    message = getattr(response, "message", None)
    if isinstance(message, dict):
        content = message.get("content")
    elif message is not None:
        content = getattr(message, "content", None)
    elif isinstance(response, dict):
        raw_message = response.get("message")
        content = raw_message.get("content") if isinstance(raw_message, dict) else None
    else:
        content = None
    return content if isinstance(content, str) else ""


def _jsonable(value: Any) -> object:
    if value is None or isinstance(value, str | int | float | bool):
        return value
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, list | tuple | set):
        return [_jsonable(item) for item in value]
    if hasattr(value, "model_dump"):
        return _jsonable(value.model_dump())
    if hasattr(value, "__dict__"):
        return _jsonable(vars(value))
    return repr(value)


def _int_or_none(value: str) -> int | None:
    try:
        return int(value)
    except ValueError:
        return None


def _float_or_none(value: str) -> float | None:
    try:
        return float(value)
    except ValueError:
        return None


def _rss_kib_to_bytes(value: str) -> int | None:
    parsed = _int_or_none(value)
    return None if parsed is None else parsed * 1024


def _windows_mem_usage_to_bytes(value: str) -> int | None:
    digits = "".join(char for char in value if char.isdigit())
    return None if not digits else int(digits) * 1024


def write_json_report(report: dict[str, object], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    models = tuple(args.models or DEFAULT_MODELS)
    report = build_report(
        models=models,
        host=args.host,
        timeout_seconds=args.timeout_seconds,
    )
    write_json_report(report, args.output)
    print(json.dumps({"output": str(args.output), "models": list(models)}, indent=2))


if __name__ == "__main__":
    main()
