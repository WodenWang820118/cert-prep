from __future__ import annotations


class SourceDocumentUnavailable(RuntimeError):
    """The document cannot be given in the form asked for, e.g. Markdown of an image."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
