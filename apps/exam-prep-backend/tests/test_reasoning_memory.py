from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from reasoning_memory import (  # noqa: E402
    _parse_tasklist_processes,
    _parse_typeperf_samples,
    default_output_path,
    model_names_from_ollama_list_response,
    model_names_from_ollama_list_stdout,
    observe_model_memory,
)


def test_reasoning_memory_extracts_model_names_from_api_shapes() -> None:
    assert model_names_from_ollama_list_response(
        {
            "models": [
                {"model": "qwen3.5:4b"},
                {"name": "gemma4:12b"},
            ]
        }
    ) == {"qwen3.5:4b", "gemma4:12b"}

    response = SimpleNamespace(
        models=[
            SimpleNamespace(model="deepseek-r1:14b"),
        ]
    )

    assert model_names_from_ollama_list_response(response) == {"deepseek-r1:14b"}


def test_reasoning_memory_extracts_model_names_from_cli_table() -> None:
    stdout = """NAME              ID              SIZE      MODIFIED
qwen3.5:4b         abc123          9.3 GB    2 days ago
deepseek-r1:14b   def456          9.0 GB    1 week ago
"""

    assert model_names_from_ollama_list_stdout(stdout) == [
        "deepseek-r1:14b",
        "qwen3.5:4b",
    ]


def test_reasoning_memory_missing_model_skips_request() -> None:
    result = observe_model_memory(
        client=object(),
        model="gemma4:12b",
        available_models=set(),
        host="http://127.0.0.1:11434",
        timeout_seconds=1,
        model_list_available=True,
        model_list_error=None,
    )

    assert result["status"] == "missing_model"
    assert result["blocker"] is True
    assert result["observations"] == []


def test_reasoning_memory_default_output_is_backend_benchmark_path() -> None:
    output = default_output_path()

    assert output.parent.name == ".benchmarks"
    assert output.name.startswith("reasoning-memory-")
    assert output.suffix == ".json"


def test_reasoning_memory_parses_tasklist_process_rows() -> None:
    stdout = (
        '"ollama.exe","1234","Console","1","21,504 K"\n'
        '"llama-server.exe","5678","Console","1","5,821,000 K"\n'
        '"brave.exe","9999","Console","1","1,000 K"\n'
    )

    assert _parse_tasklist_processes(stdout) == [
        {"name": "ollama.exe", "pid": 1234, "rss_bytes": 22020096},
        {"name": "llama-server.exe", "pid": 5678, "rss_bytes": 5960704000},
    ]


def test_reasoning_memory_parses_nonzero_typeperf_gpu_samples() -> None:
    stdout = (
        '"(PDH-CSV 4.0)","\\\\MSI\\GPU Adapter Memory(a)\\Dedicated Usage",'
        '"\\\\MSI\\GPU Engine(pid_1)\\Utilization Percentage"\n'
        '"06/21/2026 16:30:51.151","275030016.000000","0.500000"\n'
        "Exiting, please wait...\n"
    )

    assert _parse_typeperf_samples(stdout) == [
        {
            "path": "\\\\MSI\\GPU Adapter Memory(a)\\Dedicated Usage",
            "value": 275030016.0,
        },
        {
            "path": "\\\\MSI\\GPU Engine(pid_1)\\Utilization Percentage",
            "value": 0.5,
        },
    ]
