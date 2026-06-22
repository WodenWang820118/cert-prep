from __future__ import annotations


class BackendError(Exception):
    """Base exception for expected backend failures."""


class NotFoundError(BackendError):
    pass


class ValidationError(BackendError):
    pass


class InvalidPdfError(ValidationError):
    pass


class ProviderUnavailableError(BackendError):
    pass
