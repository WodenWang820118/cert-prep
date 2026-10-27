"""Capture review sessions: which transitions a session accepts, and which it refuses."""

from __future__ import annotations

from dataclasses import replace

import pytest

from cert_prep_backend.capture_integration.domain.review_session import (
    CaptureReviewEnding,
    CaptureReviewSession,
    CaptureReviewStatus,
    CaptureReviewTransitionError,
    event_sequence,
)

Status = CaptureReviewStatus
NOW = "2026-10-27T00:00:00+00:00"
LATER = "2026-10-27T01:00:00+00:00"


def _session(status: Status = Status.PENDING, **changes: object) -> CaptureReviewSession:
    session = CaptureReviewSession(
        id="session",
        project_id="project",
        document_id="document",
        operation_id="operation",
        runtime_capture_id=None,
        status=status,
        review_revision=0,
        expires_at=NOW,
        created_at=NOW,
        updated_at=NOW,
        confirm_request_id=None,
        confirm_review_digest=None,
        last_event_sequence=0,
    )
    return replace(session, **changes)


def test_only_a_pending_session_records_a_runtime_capture_id() -> None:
    pending = _session()
    bound = pending.with_runtime_capture("runtime", now=LATER)

    assert bound.runtime_capture_id == "runtime"
    assert bound.updated_at == LATER
    assert bound.status is Status.PENDING
    assert pending.runtime_capture_id is None
    for status in (Status.CONFIRMING, Status.COMPLETED, Status.CANCELED, Status.FAILED):
        with pytest.raises(CaptureReviewTransitionError, match="no longer pending"):
            _session(status).with_runtime_capture("runtime", now=LATER)


def test_confirming_repeats_with_no_request_id_and_the_same_revision() -> None:
    session = _session(
        Status.CONFIRMING,
        review_revision=4,
        confirm_request_id="request",
        confirm_review_digest="digest",
    )

    claimed, acquired = session.claim_confirmation(
        review_revision=4,
        client_request_id=None,
        review_digest="other",
        now=LATER,
    )

    assert acquired is False
    assert claimed is session


def test_a_confirming_session_repeats_when_the_request_id_and_digest_match() -> None:
    session = _session(
        Status.CONFIRMING,
        review_revision=4,
        confirm_request_id="request",
        confirm_review_digest="digest",
    )

    claimed, acquired = session.claim_confirmation(
        review_revision=99,
        client_request_id="request",
        review_digest="digest",
        now=LATER,
    )

    assert acquired is False
    assert claimed is session


def test_reusing_a_client_request_id_with_different_review_data_is_rejected() -> None:
    session = _session(
        Status.CONFIRMING,
        review_revision=4,
        confirm_request_id="request",
        confirm_review_digest="digest",
    )

    with pytest.raises(CaptureReviewTransitionError, match="different review data"):
        session.claim_confirmation(
            review_revision=4,
            client_request_id="request",
            review_digest="other",
            now=LATER,
        )


def test_a_confirming_session_with_a_different_request_is_not_pending() -> None:
    session = _session(Status.CONFIRMING, confirm_request_id="kept", confirm_review_digest="digest")

    with pytest.raises(CaptureReviewTransitionError, match="not pending confirmation"):
        session.claim_confirmation(
            review_revision=1,
            client_request_id="other",
            review_digest="digest",
            now=LATER,
        )


@pytest.mark.parametrize("status", [Status.COMPLETED, Status.CANCELED, Status.FAILED])
def test_a_session_that_is_not_pending_cannot_be_claimed(status: Status) -> None:
    with pytest.raises(CaptureReviewTransitionError, match="not pending confirmation"):
        _session(status).claim_confirmation(
            review_revision=1,
            client_request_id="request",
            review_digest="digest",
            now=LATER,
        )


def test_a_pending_session_is_claimed_for_confirmation() -> None:
    session = _session()

    claimed, acquired = session.claim_confirmation(
        review_revision=4,
        client_request_id="request",
        review_digest="digest",
        now=LATER,
    )

    assert acquired is True
    assert claimed.status is Status.CONFIRMING
    assert (claimed.review_revision, claimed.confirm_request_id) == (4, "request")
    assert claimed.confirm_review_digest == "digest"
    assert claimed.updated_at == LATER
    assert claimed.id == session.id
    assert session.status is Status.PENDING


def test_an_active_session_without_a_terminal_sequence_advances_one_past_its_last_event() -> None:
    session = _session(last_event_sequence=4)

    finished = session.finished(CaptureReviewEnding("completed"), now=LATER)

    assert finished.status is Status.COMPLETED
    assert finished.last_event_sequence == 5
    assert finished.updated_at == LATER
    assert session.last_event_sequence == 4


def test_an_active_session_finishes_at_a_higher_terminal_sequence() -> None:
    session = _session(Status.CONFIRMING, last_event_sequence=4)

    finished = session.finished(CaptureReviewEnding(Status.FAILED, 9), now=LATER)

    assert (finished.status, finished.last_event_sequence, finished.updated_at) == (
        Status.FAILED,
        9,
        LATER,
    )


def test_an_active_session_keeps_its_sequence_when_the_terminal_sequence_is_lower() -> None:
    session = _session(last_event_sequence=4)

    finished = session.finished(CaptureReviewEnding(Status.CANCELED, 2), now=LATER)

    assert (finished.status, finished.last_event_sequence, finished.updated_at) == (
        Status.CANCELED,
        4,
        LATER,
    )


def test_a_terminal_session_stores_a_higher_sequence_without_changing_status_or_time() -> None:
    session = _session(Status.COMPLETED, last_event_sequence=4)

    finished = session.finished(CaptureReviewEnding(Status.FAILED, 6), now=LATER)

    assert finished is not session
    assert finished.status is Status.COMPLETED
    assert finished.last_event_sequence == 6
    assert finished.updated_at == NOW


def test_a_terminal_session_ignores_a_lower_sequence() -> None:
    session = _session(Status.CANCELED, last_event_sequence=4)

    assert session.finished(CaptureReviewEnding(Status.FAILED, 2), now=LATER) is session


def test_a_terminal_session_ignores_a_missing_sequence() -> None:
    session = _session(Status.FAILED, last_event_sequence=4)

    assert session.finished(CaptureReviewEnding(Status.COMPLETED), now=LATER) is session


def test_an_ending_rejects_a_non_terminal_status() -> None:
    with pytest.raises(ValueError, match="Unsupported capture review terminal status: pending"):
        CaptureReviewEnding("pending")
    with pytest.raises(ValueError, match="Unsupported capture review terminal status: confirming"):
        CaptureReviewEnding(Status.CONFIRMING)


@pytest.mark.parametrize("sequence", [0, True, 1.0])
def test_an_ending_rejects_a_sequence_that_is_not_a_positive_integer(sequence: object) -> None:
    with pytest.raises(
        ValueError,
        match=r"^Terminal capture event sequence must be a positive integer\.$",
    ):
        CaptureReviewEnding(Status.COMPLETED, sequence)


@pytest.mark.parametrize("sequence", [-1, True, 1.0])
def test_event_sequence_rejects_negative_bool_and_float(sequence: object) -> None:
    with pytest.raises(
        ValueError,
        match=r"^Capture event sequence must be a non-negative integer\.$",
    ):
        event_sequence(sequence)


def test_event_sequence_accepts_zero() -> None:
    assert event_sequence(0) == 0
