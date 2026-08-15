"""Cert Prep review behavior layered on published Capture Runtime v2 DTOs."""

from capture_runtime_client import RawCapture

from cert_prep_backend.domains.capture_workbench.host_models import CaptureReview


def reviewed_text_overrides(
    raw: RawCapture,
    review: CaptureReview,
) -> dict[str, str]:
    """Validate review edits against immutable runtime extraction provenance."""

    segments = {segment.segment_id: segment for segment in raw.segments}
    overrides: dict[str, str] = {}
    for edit in review.edits:
        segment = segments.get(edit.segment_id)
        if segment is None:
            raise ValueError(f"review edit references unknown segmentId {edit.segment_id!r}")
        if not edit.reviewed_text.strip():
            raise ValueError(f"reviewedText for {edit.segment_id!r} must not be empty")
        if edit.reviewed_text == segment.text:
            continue
        overrides[edit.segment_id] = edit.reviewed_text
    return overrides


__all__ = ["CaptureReview", "reviewed_text_overrides"]
