"""Exceptions for the cert-prep-ollama package."""

from __future__ import annotations


class OllamaError(Exception):
    """Base exception for Ollama infrastructure errors."""


class ProviderUnavailableError(OllamaError):
    """Raised when an Ollama provider or its prerequisites are not available."""

    def __init__(self, message: str, *, code: str = "provider_unavailable") -> None:
        super().__init__(message)
        self.code = code
