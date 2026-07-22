"""Atomic Cert Prep persistence of sidecar-validated CaptureDocumentV1 data."""

from __future__ import annotations

from cert_prep_backend.domains.capture_workbench.contracts import CaptureDocumentV1
from cert_prep_backend.domains.capture_workbench.mapping import (
    capture_document_to_audio_segments,
    capture_document_to_pdf_extraction,
)
from cert_prep_backend.domains.source_documents import operations
from cert_prep_backend.persistence.database import Database


def publish_capture_document(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
    source_kind: str,
    expected_sha256: str,
    document: CaptureDocumentV1,
) -> dict:
    if document.source.sha256 != expected_sha256:
        raise ValueError("Capture Runtime result does not match the stored source digest")

    if source_kind == "audio":
        mapped = capture_document_to_audio_segments(document)
        warning = "; ".join(document.warnings) or None
        return operations.publish_capture_audio_success(
            db,
            project_id=project_id,
            operation_id=operation_id,
            document_id=document_id,
            segments=tuple(
                (segment.transcript, segment.target_text) for segment in mapped
            ),
            model=document.extraction_engine.model,
            device=document.extraction_engine.device,
            warning=warning,
        )

    extraction = capture_document_to_pdf_extraction(document)
    return operations.publish_success(
        db,
        project_id=project_id,
        operation_id=operation_id,
        document_id=document_id,
        extraction=extraction,
    )


__all__ = ["publish_capture_document"]
