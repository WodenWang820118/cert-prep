"""Providers and the runtime guard that several Capture Reviews routes share.

Each provider reads the resource create_app put on app.state for this app, so two apps never
share one.
"""

from __future__ import annotations

from fastapi import Request, status

from cert_prep_backend.api.errors import api_error
from cert_prep_backend.capture_integration.application.ports import (
    CaptureBackgroundWork,
    CaptureSources,
    CaptureFileStore,
    CaptureOperations,
    CaptureReviewEvents,
    CaptureReviewMaintenance,
    CaptureReviewStore,
    CaptureReviewWorkflow,
    CaptureRuntime,
)


def require_capture_coordinator(request: Request) -> None:
    """Answer 503 when this process has no Capture Runtime configured."""
    if request.app.state.capture_coordinator is None:
        raise api_error(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="capture_runtime_unavailable",
            message="Capture Runtime is not configured for this process.",
        )


def get_capture_sources(request: Request) -> CaptureSources:
    return request.app.state.source_repository


def get_capture_operations(request: Request) -> CaptureOperations:
    return request.app.state.source_operation_repository


def get_capture_file_store(request: Request) -> CaptureFileStore:
    return request.app.state.source_file_store


def get_capture_review_store(request: Request) -> CaptureReviewStore:
    return request.app.state.capture_review_store


def get_capture_review_workflow(request: Request) -> CaptureReviewWorkflow:
    return request.app.state.capture_review_workflow


def get_capture_review_maintenance(request: Request) -> CaptureReviewMaintenance:
    return request.app.state.capture_review_maintenance


def get_capture_runtime(request: Request) -> CaptureRuntime | None:
    return request.app.state.capture_runtime


def get_capture_background_work(request: Request) -> CaptureBackgroundWork:
    return request.app.state.capture_background_work


def get_capture_review_events(request: Request) -> CaptureReviewEvents:
    return request.app.state.capture_runtime_event_registry
