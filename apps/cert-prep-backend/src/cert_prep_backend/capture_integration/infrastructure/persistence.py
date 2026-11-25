"""Atomic Cert Prep persistence of sidecar-validated CaptureDocument data."""

from __future__ import annotations

import json

from capture_runtime_client import CaptureDocument
from cert_prep_contracts.documents import SourceKind

from cert_prep_backend.capture_integration.application.ports import CapturePublication
from cert_prep_backend.capture_integration.infrastructure.host_models import CaptureReview
from cert_prep_backend.capture_integration.infrastructure.mapping import (
    capture_document_to_audio_segments,
    capture_document_to_page_extraction,
)
from cert_prep_backend.source_library.domain.document import SourceDocument


def publish_capture_document(
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
    source_kind: SourceKind,
    expected_sha256: str,
    document: CaptureDocument,
    runtime_version: str,
    review: CaptureReview | None = None,
    ocr_projection: object | None = None,
    publication: CapturePublication,
) -> SourceDocument:
    if document.source.sha256 != expected_sha256:
        raise ValueError("Capture Runtime result does not match the stored source digest")

    extraction_provenance = json.dumps(
        {
            "engine": document.extraction_engine.model_dump(mode="json", by_alias=True),
            "runtime_version": runtime_version,
        }
    )

    if source_kind == "recording":
        mapped = capture_document_to_audio_segments(document)
        warning = "; ".join(document.warnings) or None
        return publication.publish_audio_success(
            project_id=project_id,
            operation_id=operation_id,
            document_id=document_id,
            segments=tuple(
                (segment.transcript, segment.target_text) for segment in mapped
            ),
            model=document.extraction_engine.model,
            device=document.extraction_engine.device,
            warning=warning,
            extraction_provenance=extraction_provenance,
        )

    if ocr_projection is None:
        raise ValueError(
            "Capture Runtime OCR projection is required for new PDF/image imports."
        )
    extraction = capture_document_to_page_extraction(
        document,
        review=review,
        ocr_projection=ocr_projection,
    )
    return publication.publish_success(
        project_id=project_id,
        operation_id=operation_id,
        document_id=document_id,
        extraction=extraction,
        extraction_provenance=extraction_provenance,
    )


__all__ = ["publish_capture_document"]
