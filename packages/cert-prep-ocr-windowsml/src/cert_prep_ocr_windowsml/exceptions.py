from __future__ import annotations


class ProviderUnavailableError(RuntimeError):
    """Raised when the WindowsML OCR runtime cannot serve an OCR request."""
