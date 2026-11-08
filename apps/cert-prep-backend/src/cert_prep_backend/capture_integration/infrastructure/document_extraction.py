"""Capture Runtime as the Source Library's text extraction for imports without a review."""

from __future__ import annotations

import logging
from collections.abc import Callable

from capture_runtime_client import CaptureSourceKind

from cert_prep_backend.capture_integration.application.ports import CapturePublication
from cert_prep_backend.capture_integration.infrastructure.coordinator import (
    PDF_OCR_UNAVAILABLE_MESSAGE,
    CaptureRuntimeCanceledError,
    CaptureRuntimeJobError,
    CaptureRuntimeRequirementUnavailableError,
    CertPrepCaptureCoordinator,
)
from cert_prep_backend.capture_integration.infrastructure.persistence import (
    publish_capture_document,
)
from cert_prep_backend.platform.errors import (
    DocumentProcessingCanceledError,
    ProviderUnavailableError,
)
from cert_prep_backend.source_library.application.errors import (
    SourceExtractionFailed,
    SourceTextNotDetected,
)
from cert_prep_backend.source_library.domain.document import SourceDocument

logger = logging.getLogger(__name__)
_MEDIA_TYPES = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
}
# Language hints Capture's speech recognition is told for audio; the rest keep its Chinese default.
_CAPTURE_SPOKEN_LANGUAGES = {"ja": "ja", "en": "en"}
_REQUIREMENTS_UNAVAILABLE = "Capture Runtime extraction requirements are unavailable."


def capture_spoken_language(language_hint: str) -> str | None:
    """Capture's speech recognition assumes Chinese, so name only the other languages a hint
    states."""

    return _CAPTURE_SPOKEN_LANGUAGES.get(language_hint)


class CaptureSourceExtraction:
    """Runs one capture without a review, stores its result as the document's chunks, and
    deletes the runtime's copy. Capture errors become the Source Library's errors."""

    def __init__(
        self,
        coordinator: CertPrepCaptureCoordinator,
        *,
        publication: CapturePublication,
    ) -> None:
        self._coordinator = coordinator
        self._publication = publication

    def extract(
        self,
        *,
        project_id: str,
        document_id: str,
        operation_id: str,
        file_name: str,
        content: bytes,
        canonical_suffix: str,
        source_kind: str,
        sha256: str,
        language_hint: str,
        should_cancel: Callable[[], bool],
    ) -> SourceDocument:
        is_audio = source_kind == "audio"
        try:
            capture = self._coordinator.capture(
                operation_id=operation_id,
                file_name=file_name,
                content=content,
                media_type=_MEDIA_TYPES.get(canonical_suffix.lower(), "application/octet-stream"),
                source_kind=CaptureSourceKind(source_kind),
                target_language="zh-Hant" if is_audio else None,
                should_cancel=should_cancel,
                spoken_language=capture_spoken_language(language_hint) if is_audio else None,
            )
        except CaptureRuntimeCanceledError as error:
            raise DocumentProcessingCanceledError(str(error)) from error
        except CaptureRuntimeRequirementUnavailableError as error:
            message = PDF_OCR_UNAVAILABLE_MESSAGE if source_kind == "pdf" else str(error)
            raise ProviderUnavailableError(message) from error
        except CaptureRuntimeJobError as error:
            if error.code == "requirement_unavailable":
                message = (
                    PDF_OCR_UNAVAILABLE_MESSAGE
                    if source_kind == "pdf"
                    else _REQUIREMENTS_UNAVAILABLE
                )
                raise ProviderUnavailableError(message) from error
            if error.code == "no_text_detected":
                raise SourceTextNotDetected(str(error)) from error
            raise SourceExtractionFailed(str(error)) from error

        document = publish_capture_document(
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
            source_kind=source_kind,
            expected_sha256=sha256,
            document=capture.document,
            ocr_projection=capture.ocr_projection,
            publication=self._publication,
        )
        try:
            self._coordinator.delete(capture.capture_id)
        except Exception:
            logger.warning(
                "Validated Capture Runtime job could not be deleted after publication",
                extra={
                    "project_id": project_id,
                    "document_id": document_id,
                    "capture_id": capture.capture_id,
                },
            )
        return document


__all__ = ["CaptureSourceExtraction", "capture_spoken_language"]
