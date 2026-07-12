from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status

from cert_prep_backend.core.exceptions import (
    BackendError,
    InvalidPdfError,
    NotFoundError,
    ProviderUnavailableError,
    ProviderReconfigurationConflictError,
    TermsAcceptanceRequiredError,
    ValidationError,
)

__all__ = [
    "BackendError",
    "InvalidPdfError",
    "NotFoundError",
    "ProviderUnavailableError",
    "ProviderReconfigurationConflictError",
    "TermsAcceptanceRequiredError",
    "ValidationError",
    "api_error",
    "not_found_error",
    "validation_error",
]


def api_error(
    status_code: int,
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> HTTPException:
    content: dict[str, Any] = {"code": code, "message": message}
    if details:
        content["details"] = details
    return HTTPException(status_code=status_code, detail=content)


def not_found_error(message: str) -> HTTPException:
    return api_error(status.HTTP_404_NOT_FOUND, "not_found", message)


def validation_error(message: str, details: dict[str, Any] | None = None) -> HTTPException:
    return api_error(status.HTTP_422_UNPROCESSABLE_CONTENT, "validation_error", message, details)
