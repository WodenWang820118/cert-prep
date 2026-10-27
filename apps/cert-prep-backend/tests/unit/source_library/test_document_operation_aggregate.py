"""The DocumentOperation aggregate: cancellation is requested while work is cancellable,
acknowledged when it stops, and refused once the result is being committed."""

from __future__ import annotations

from dataclasses import replace

import pytest

from cert_prep_backend.platform.errors import (
    DocumentOperationConflictError,
    DocumentOperationStateError,
    DocumentProcessingCanceledError,
    OperationNotCancellableError,
)
from cert_prep_backend.source_library.domain.operation import (
    DocumentOperation,
    ensure_retry_allowed,
    failure_state,
    processing_to_cancel,
)
from cert_prep_backend.source_library.domain.statuses import (
    DocumentOperationPhase as Phase,
    DocumentOperationStatus as Status,
)

NOW = "2026-10-27T00:00:00+00:00"
LATER = "2026-10-27T00:01:00+00:00"


def _upload() -> DocumentOperation:
    return DocumentOperation.claim_upload(operation_id="op", project_id="project", now=NOW)


def _processing() -> DocumentOperation:
    return _upload().attach_document("document", NOW)


def _state(operation: DocumentOperation) -> tuple[Status, Phase, bool]:
    return operation.status, operation.phase, operation.cancellable


def test_a_claimed_upload_is_queued_cancellable_and_has_no_document() -> None:
    upload = _upload()

    assert _state(upload) == (Status.QUEUED, Phase.UPLOADING, True)
    assert upload.document_id is None
    assert upload.created_at == upload.updated_at == NOW


def test_attaching_the_document_starts_processing() -> None:
    processing = _upload().attach_document("document", LATER)

    assert _state(processing) == (Status.RUNNING, Phase.PROCESSING, True)
    assert processing.document_id == "document"
    assert processing.updated_at == LATER


def test_a_document_attaches_only_to_a_fresh_upload_claim() -> None:
    with pytest.raises(DocumentOperationStateError, match="exclusively claimed"):
        _processing().attach_document("other", NOW)
    with pytest.raises(DocumentProcessingCanceledError, match="upload was canceled"):
        _upload().cancel(NOW).attach_document("document", NOW)


def test_a_queued_upload_is_canceled_at_once() -> None:
    canceled = _upload().cancel(LATER)

    assert _state(canceled) == (Status.CANCELED, Phase.CANCELED, False)
    assert canceled.error is None


@pytest.mark.parametrize(
    "phase",
    [Phase.PROCESSING, Phase.AWAITING_REVIEW, Phase.TRANSCRIBING, Phase.TRANSLATING],
)
def test_running_work_in_a_cancellable_phase_has_its_cancellation_requested(
    phase: Phase,
) -> None:
    requested = replace(_processing(), phase=phase).cancel(LATER)

    assert _state(requested) == (Status.CANCEL_REQUESTED, Phase.CANCELING, False)


def test_committing_work_can_no_longer_be_canceled() -> None:
    committing = _processing().begin_commit("document", NOW)

    with pytest.raises(OperationNotCancellableError):
        committing.cancel(LATER)


def test_cancel_names_an_unexpected_phase() -> None:
    odd = replace(_processing(), phase=Phase.COMMITTING)

    with pytest.raises(
        DocumentOperationStateError,
        match="^Document operation cannot be canceled from running/committing.$",
    ):
        odd.cancel(LATER)


def test_canceling_twice_or_after_the_end_changes_nothing() -> None:
    requested = _processing().cancel(NOW)
    succeeded = _processing().begin_commit("document", NOW).succeed(NOW)

    assert requested.cancel(LATER) is requested
    assert succeeded.cancel(LATER) is succeeded


def test_a_capture_review_stays_cancellable_until_it_is_confirmed() -> None:
    in_review = _processing().enter_review("document", NOW)
    confirmed = in_review.begin_review_confirmation("document", LATER)

    assert _state(in_review) == (Status.RUNNING, Phase.AWAITING_REVIEW, True)
    assert _state(confirmed) == (Status.RUNNING, Phase.PROCESSING, True)
    with pytest.raises(DocumentOperationStateError, match="already running or completed"):
        confirmed.begin_review_confirmation("document", LATER)
    with pytest.raises(DocumentProcessingCanceledError):
        in_review.cancel(LATER).begin_review_confirmation("document", LATER)


def test_only_processing_work_enters_review() -> None:
    with pytest.raises(DocumentOperationStateError, match="could not enter capture review"):
        _processing().enter_review("other", NOW)
    with pytest.raises(DocumentOperationStateError, match="could not enter capture review"):
        _upload().enter_review("document", NOW)


def test_committing_wins_the_race_against_cancellation() -> None:
    committing = _processing().begin_commit("document", LATER)

    assert _state(committing) == (Status.RUNNING, Phase.COMMITTING, False)
    assert _state(committing.succeed(LATER)) == (Status.SUCCEEDED, Phase.COMPLETED, False)


def test_a_commit_needs_its_own_document_and_cancellable_processing() -> None:
    with pytest.raises(DocumentOperationStateError, match="does not own"):
        _processing().begin_commit("other", NOW)
    with pytest.raises(DocumentProcessingCanceledError):
        _processing().cancel(NOW).begin_commit("document", NOW)
    with pytest.raises(DocumentOperationStateError, match="cancellable processing phase"):
        _processing().enter_review("document", NOW).begin_commit("document", NOW)


def test_published_results_are_recognized_and_other_endings_refuse_publication() -> None:
    succeeded = _processing().begin_commit("document", NOW).succeed(NOW)
    failed = _processing().fail("OCR crashed", NOW)

    assert succeeded.already_published("document", results="extraction results") is True
    assert _processing().already_published("document", results="extraction results") is False
    with pytest.raises(DocumentProcessingCanceledError):
        _processing().cancel(NOW).already_published("document", results="extraction results")
    with pytest.raises(
        DocumentOperationStateError,
        match="^Terminal document operation cannot publish capture results.$",
    ):
        failed.already_published("document", results="capture results")


def test_a_requested_cancellation_is_acknowledged_as_canceled() -> None:
    requested = _processing().cancel(NOW)
    canceled = requested.acknowledge_cancellation(LATER)

    assert _state(canceled) == (Status.CANCELED, Phase.CANCELED, False)
    assert canceled.acknowledge_cancellation(LATER) is canceled
    with pytest.raises(DocumentOperationStateError, match="Only a requested cancellation"):
        _processing().acknowledge_cancellation(LATER)


def test_a_failure_after_a_cancel_request_ends_as_canceled() -> None:
    failed = _processing().fail("OCR crashed", LATER)
    canceled = _processing().cancel(NOW).fail("OCR crashed", LATER)

    assert _state(failed) == (Status.FAILED, Phase.FAILED, False)
    assert failed.error == "OCR crashed"
    assert _state(canceled) == (Status.CANCELED, Phase.CANCELED, False)
    assert canceled.error is None
    assert failed.fail("again", LATER) is failed


def test_an_operation_id_belongs_to_one_project() -> None:
    with pytest.raises(DocumentOperationConflictError):
        _upload().ensure_belongs_to("other-project")


def test_a_retry_never_reuses_an_operation_id() -> None:
    with pytest.raises(DocumentOperationConflictError, match="already in use"):
        _processing().refuse_reuse_for_retry("project")
    with pytest.raises(DocumentProcessingCanceledError, match="canceled before it started"):
        DocumentOperation.canceled_before_start(
            operation_id="op", project_id="project", now=NOW
        ).refuse_reuse_for_retry("project")


def test_a_retry_needs_a_retryable_outcome_and_no_running_work() -> None:
    for status in ("canceled", "ocr_failed", "no_text_detected", "transcription_failed"):
        ensure_retry_allowed(has_active_operation=False, document_status=status)
    with pytest.raises(DocumentOperationConflictError, match="active processing operation"):
        ensure_retry_allowed(has_active_operation=True, document_status="ocr_failed")
    with pytest.raises(DocumentOperationStateError, match="not eligible"):
        ensure_retry_allowed(has_active_operation=False, document_status="ready")


def test_a_retry_starts_processing_at_once() -> None:
    retry = DocumentOperation.start_retry(
        operation_id="retry", project_id="project", document_id="document", now=NOW
    )

    assert _state(retry) == (Status.RUNNING, Phase.PROCESSING, True)
    assert retry.document_id == "document"


def test_a_failed_page_document_keeps_its_reason_and_a_canceled_one_resets() -> None:
    failed = _processing().fail("No text found.", NOW)
    canceled = _processing().cancel(NOW).fail("ignored", NOW)

    no_text = failure_state(
        failed, document_status="no_text_detected", extraction_method="ocr", page_count=3
    )
    default = failure_state(failed, document_status=None, extraction_method=None, page_count=3)

    assert (no_text.status, no_text.fallback_reason, no_text.processed_page_count) == (
        "no_text_detected",
        "No text found.",
        3,
    )
    assert (default.status, default.extraction_method, default.processed_page_count) == (
        "ocr_failed",
        "ocr_failed",
        0,
    )
    assert failure_state(
        canceled, document_status="ocr_failed", extraction_method="ocr", page_count=3
    ) == failure_state(canceled, document_status=None, extraction_method=None, page_count=0)


def test_canceling_a_document_finds_its_running_or_last_canceled_operation() -> None:
    active = _processing()
    canceled = _processing().cancel(NOW).acknowledge_cancellation(NOW)

    assert (
        processing_to_cancel(active=active, document_status="processing", last_canceled=None)
        is active
    )
    assert (
        processing_to_cancel(active=None, document_status="canceled", last_canceled=canceled)
        is canceled
    )
    with pytest.raises(DocumentOperationStateError, match="no owning document operation"):
        processing_to_cancel(active=None, document_status="canceled", last_canceled=None)
    with pytest.raises(DocumentOperationStateError, match="no active document operation"):
        processing_to_cancel(active=None, document_status="processing", last_canceled=None)
    with pytest.raises(OperationNotCancellableError):
        processing_to_cancel(active=None, document_status="ready", last_canceled=None)
