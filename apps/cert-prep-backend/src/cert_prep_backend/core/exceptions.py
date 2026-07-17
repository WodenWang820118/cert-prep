from __future__ import annotations

class BackendError(Exception):
    """Base exception for expected backend failures."""


class NotFoundError(BackendError):
    pass


class ValidationError(BackendError):
    pass


class InvalidSourceError(ValidationError):
    pass


class InvalidPdfError(InvalidSourceError):
    pass


class ProviderUnavailableError(BackendError):
    """Raised when a provider or its prerequisites are not available."""


class DocumentOperationConflictError(BackendError):
    """Raised when an operation id or document already belongs to other work."""


class DocumentProcessingCanceledError(BackendError):
    """Raised when canceled document work reaches a persistence checkpoint."""


class OperationNotCancellableError(BackendError):
    """Raised when work has entered a non-interruptible commit phase."""


class DocumentOperationStateError(BackendError):
    """Raised when a document operation cannot perform the requested transition."""
