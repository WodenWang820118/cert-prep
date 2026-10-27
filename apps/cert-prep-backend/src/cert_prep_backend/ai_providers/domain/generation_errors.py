"""Which failures of a generation call are worth retrying or skipping, and how they are shown."""

from __future__ import annotations


def short_error(exc: Exception) -> str:
    return short_error_text(str(exc) or exc.__class__.__name__)


def short_error_text(value: str) -> str:
    return " ".join(value.split())[:240]


def is_non_fatal_generation_error(exc: Exception) -> bool:
    error = short_error(exc).lower()
    return any(
        marker in error
        for marker in (
            "invalid json",
            "unreadable response",
            "non-object json response",
            "timed out",
            "timeout",
        )
    )


def is_runtime_model_failure(exc: Exception) -> bool:
    return not is_non_fatal_generation_error(exc)
