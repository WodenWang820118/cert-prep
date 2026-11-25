"""The project-scoped Capture Reviews API: one router that registers each route family.

The route modules declare their handlers; this module includes them once, in this order. The
order fixes route matching and the order of the OpenAPI document and the generated client.
"""

from __future__ import annotations

from fastapi import APIRouter

from cert_prep_backend.capture_integration.api import (
    review_events,
    review_extraction,
    review_lifecycle,
    review_results,
    review_structuring,
    review_uploads,
)
from cert_prep_backend.capture_integration.api.capture_event_stream import (
    CaptureRuntimeEventRegistry,
)


router = APIRouter(
    prefix="/projects/{project_id}/capture-reviews",
    tags=["capture-reviews"],
)
review_uploads.register_upload(router)
review_lifecycle.register_status(router)
review_extraction.register_ocr_summary(router)
review_events.register_events(router)
review_extraction.register_extraction_reads(router)
review_structuring.register_structuring(router)
review_lifecycle.register_cancellation(router)
review_results.register_result(router)
review_lifecycle.register_discard(router)


__all__ = ["CaptureRuntimeEventRegistry", "router"]
