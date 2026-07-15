"""Ollama model helpers."""

from __future__ import annotations

from typing import Any

from cert_prep_contracts.llm import (
    DEFAULT_LLM_PRIMARY_MODEL,
    ModelPullProgress as _ModelPullProgress,
)


DEFAULT_OLLAMA_MODEL = DEFAULT_LLM_PRIMARY_MODEL


def extract_model_names(response: Any) -> set[str]:
    """Extract model names from the shapes returned by Ollama clients."""

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
            if name.endswith(":latest"):
                # Ollama treats an omitted tag as the implicit `latest` tag.
                untagged_name = name.removesuffix(":latest")
                if untagged_name:
                    names.add(untagged_name)
    return names


def pull_progress(response: Any) -> _ModelPullProgress:
    """Normalize streamed Ollama pull progress into domain progress values."""

    status = getattr(response, "status", None)
    completed = getattr(response, "completed", None)
    total = getattr(response, "total", None)
    if isinstance(response, dict):
        status = response.get("status", status)
        completed = response.get("completed", completed)
        total = response.get("total", total)
    return _ModelPullProgress(
        status=status if isinstance(status, str) else "downloading model",
        completed=completed if isinstance(completed, int) else None,
        total=total if isinstance(total, int) else None,
    )


__all__ = [
    "DEFAULT_OLLAMA_MODEL",
    "extract_model_names",
    "pull_progress",
]
