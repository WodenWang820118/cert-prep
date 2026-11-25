"""Reads of a capture's extraction while it is reviewed: OCR summary, partial and raw."""

from __future__ import annotations

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    status,
)

from capture_runtime_client import (
    PartialCapture,
    RawCapture,
)
from cert_prep_backend.platform.dependencies import get_database
from cert_prep_backend.api.errors import ApiErrorRead, api_error, not_found_error
from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.capture_integration.api.dependencies import (
    get_capture_review_maintenance,
    get_capture_review_store,
    get_capture_runtime,
    require_capture_coordinator,
)
from cert_prep_backend.capture_integration.application import use_cases as capture_reviews
from cert_prep_backend.capture_integration.application.errors import (
    CaptureOcrClosed,
    CaptureOcrMissing,
    CaptureOcrNotReady,
    CaptureOcrTransport,
    CaptureOcrUnavailable,
    CaptureReviewConflict,
)
from cert_prep_backend.capture_integration.application.ports import CaptureRuntime
from cert_prep_backend.capture_integration.application.ocr_summary import (
    CaptureOcrSummaryRead,
)
from cert_prep_backend.platform.database import Database

_OCR_SUMMARY_NOT_FOUND_RESPONSE = {
    "model": ApiErrorRead,
    "description": "The project-scoped capture was not found.",
}
_OCR_SUMMARY_CONFLICT_RESPONSE = {
    "model": ApiErrorRead,
    "description": "The OCR summary has not reached a stable projection.",
}
_OCR_SUMMARY_GONE_RESPONSE = {
    "model": ApiErrorRead,
    "description": "The durable capture review is closed.",
}
_OCR_SUMMARY_BAD_GATEWAY_RESPONSE = {
    "model": ApiErrorRead,
    "description": "Capture Runtime did not provide safe stable OCR evidence.",
}
_OCR_SUMMARY_UNAVAILABLE_RESPONSE = {
    "model": ApiErrorRead,
    "description": "Capture Runtime transport is unavailable.",
}


class _OcrRuntime:
    """OCR runtime reads, reached only after the session gates inside the use case."""

    def __init__(self, request: Request, runtime: CaptureRuntime | None) -> None:
        self._request = request
        self._runtime = runtime

    def read_operation_for_ocr(self, runtime_capture_id: str) -> object:
        return self._runtime_after_gates().read_operation_for_ocr(runtime_capture_id)

    def read_ocr_projection(self, runtime_capture_id: str) -> object:
        return self._runtime_after_gates().read_ocr_projection(runtime_capture_id)

    def _runtime_after_gates(self) -> CaptureRuntime:
        # A missing client answers 503 here, after those gates, and not with the
        # coordinator's "not configured" message.
        if self._request.app.state.capture_runtime_client is None:
            raise api_error(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                code="capture_runtime_unavailable",
                message="Capture Runtime is unavailable.",
            )
        runtime = self._runtime
        assert runtime is not None
        return runtime


def register_ocr_summary(router: APIRouter) -> None:
    router.get(
        "/{capture_id}/ocr-summary",
        response_model=CaptureOcrSummaryRead,
        responses={
            status.HTTP_404_NOT_FOUND: _OCR_SUMMARY_NOT_FOUND_RESPONSE,
            status.HTTP_409_CONFLICT: _OCR_SUMMARY_CONFLICT_RESPONSE,
            status.HTTP_410_GONE: _OCR_SUMMARY_GONE_RESPONSE,
            status.HTTP_502_BAD_GATEWAY: _OCR_SUMMARY_BAD_GATEWAY_RESPONSE,
            status.HTTP_503_SERVICE_UNAVAILABLE: _OCR_SUMMARY_UNAVAILABLE_RESPONSE,
        },
    )(get_capture_ocr_summary)


def get_capture_ocr_summary(
    request: Request,
    project_id: str,
    capture_id: str,
    db: Database = Depends(get_database),
) -> CaptureOcrSummaryRead:
    """Return stable OCR evidence without exposing diagnostic capture data."""

    try:
        return capture_reviews.view_ocr_summary(
            get_capture_review_store(request),
            _OcrRuntime(request, get_capture_runtime(request)),
            project_id=project_id,
            session_id=capture_id,
        )
    except CaptureOcrMissing:
        raise not_found_error("Capture not found.") from None
    except CaptureOcrClosed:
        raise api_error(
            status_code=status.HTTP_410_GONE,
            code="capture_closed",
            message="Capture review is closed.",
        )
    except CaptureOcrNotReady:
        raise api_error(
            status_code=status.HTTP_409_CONFLICT,
            code="ocr_summary_not_ready",
            message="OCR summary is not ready.",
        )
    except CaptureOcrUnavailable:
        raise api_error(
            status_code=status.HTTP_502_BAD_GATEWAY,
            code="capture_runtime_ocr_unavailable",
            message="Capture Runtime OCR summary is unavailable.",
        ) from None
    except CaptureOcrTransport:
        raise api_error(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="capture_runtime_unavailable",
            message="Capture Runtime is unavailable.",
        ) from None


def register_extraction_reads(router: APIRouter) -> None:
    router.get("/{capture_id}/partial", response_model=PartialCapture)(get_partial)
    router.get("/{capture_id}/raw", response_model=RawCapture)(get_raw)


def get_partial(
    request: Request,
    project_id: str,
    capture_id: str,
    db: Database = Depends(get_database),
) -> PartialCapture:
    require_capture_coordinator(request)
    capture_reviews.expire_capture_reviews(get_capture_review_maintenance(request))
    try:
        partial = capture_reviews.view_partial_capture(
            get_capture_review_store(request),
            get_capture_runtime(request),
            project_id=project_id,
            session_id=capture_id,
        )
        return PartialCapture.model_validate(
            {
                **partial.model_dump(mode="json", by_alias=True),
                "captureId": capture_id,
            }
        )
    except NotFoundError as error:
        raise not_found_error(str(error)) from error
    except CaptureReviewConflict as error:
        raise HTTPException(status_code=409, detail=str(error))
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail="Capture Runtime partial extraction unavailable.",
        ) from error


def get_raw(
    request: Request,
    project_id: str,
    capture_id: str,
    db: Database = Depends(get_database),
) -> RawCapture:
    require_capture_coordinator(request)
    capture_reviews.expire_capture_reviews(get_capture_review_maintenance(request))
    try:
        return capture_reviews.view_raw_capture(
            get_capture_review_store(request),
            get_capture_runtime(request),
            project_id=project_id,
            session_id=capture_id,
        )
    except NotFoundError as error:
        raise not_found_error(str(error)) from error
    except CaptureReviewConflict as error:
        raise HTTPException(status_code=409, detail=str(error))
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail="Capture Runtime raw extraction unavailable.",
        ) from error
