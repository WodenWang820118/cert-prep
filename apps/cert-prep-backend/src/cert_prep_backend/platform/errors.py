from __future__ import annotations

class BackendError(Exception):
    """Base exception for expected backend failures."""


class NotFoundError(BackendError):
    pass


class ValidationError(BackendError):
    pass


class InvalidSourceError(ValidationError):
    pass


class LanguageModelUnavailable(BackendError):
    """Ollama or its model is unavailable, or its response cannot be used."""


class CaptureRequirementUnavailable(BackendError):
    """The running Capture Runtime lacks the source's required capability."""


class CaptureRuntimeUnavailable(BackendError):
    """The Capture Runtime cannot be reached."""


class InstallerUnavailable(BackendError):
    """An installer or download cannot run."""


class SourceOperationConflictError(BackendError):
    """Raised when an operation id or source already belongs to other work."""


class SourceProcessingCanceledError(BackendError):
    """Raised when canceled source work reaches a persistence checkpoint."""


class OperationNotCancellableError(BackendError):
    """Raised when work has entered a non-interruptible commit phase."""


class SourceOperationStateError(BackendError):
    """Raised when a source operation cannot perform the requested transition."""
