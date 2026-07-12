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
    """Raised when a provider or its prerequisites are not available."""


class TermsAcceptanceRequiredError(BackendError):
    """Raised when pinned third-party terms have not been accepted."""


class ProviderReconfigurationConflictError(BackendError):
    """Raised when provider policy changes would race active provider work."""
