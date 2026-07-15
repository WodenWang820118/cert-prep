from __future__ import annotations

from dataclasses import dataclass

from cert_prep_ollama.models import extract_model_names


@dataclass(frozen=True)
class _Model:
    model: str


@dataclass(frozen=True)
class _ModelList:
    models: list[object]


def test_extract_model_names_exposes_implicit_latest_aliases() -> None:
    response = _ModelList(
        models=[
            _Model("cert-prep-qwen3.5-4b-study-8k:latest"),
            {"model": "qwen3.5:4b"},
        ]
    )

    assert extract_model_names(response) == {
        "cert-prep-qwen3.5-4b-study-8k",
        "cert-prep-qwen3.5-4b-study-8k:latest",
        "qwen3.5:4b",
    }
