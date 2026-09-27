from __future__ import annotations

from types import SimpleNamespace

import pytest

from cert_prep_backend.domains.capture_workbench.ocr_summary import (
    OcrSummaryValidationError,
    build_ocr_summary,
)


def test_completed_projection_maps_only_privacy_safe_page_evidence() -> None:
    source = _source()
    operation = _operation(status="awaiting_structuring", source=source)
    projection = _projection(
        status="completed",
        source=source,
        pages=[
            _page(
                status="recognized",
                text="\uff21\uff22\uff23\u00a0\r\n\U0001f600",
                boxes=[object(), object()],
                confidence=0.875,
            ),
            _page(page=2, status="empty"),
        ],
    )

    summary = build_ocr_summary(
        host_capture_id="host-capture-id",
        runtime_capture_id="runtime-capture-id",
        operation=operation,
        projection=projection,
    )

    assert summary.model_dump(mode="json", by_alias=True) == {
        "projectionSchemaVersion": 3,
        "captureId": "host-capture-id",
        "status": "completed",
        "pageCount": 2,
        "pages": [
            {
                "page": 1,
                "status": "recognized",
                "normalizedCharCount": 5,
                "boxCount": 2,
                "confidence": 0.875,
                "failure": None,
            },
            {
                "page": 2,
                "status": "empty",
                "normalizedCharCount": 0,
                "boxCount": 0,
                "confidence": None,
                "failure": None,
            },
        ],
        "provenance": {
            "status": "resolved",
            "runtimeVersion": "0.4.2",
            "contractSha256": "d" * 64,
            "engine": "windowsml-ocr",
            "model": "capture-ocr-model",
            "modelDigest": "sha256:" + "b" * 64,
            "device": "directml:0",
            "profileId": "profile-1",
            "profileSpecSha256": "c" * 64,
        },
        "failure": None,
    }


def test_failed_projection_redacts_free_form_failure_and_unavailable_provenance() -> None:
    failure = SimpleNamespace(
        code="worker_timeout",
        message="private provider diagnostic",
        stage="ocr-worker",
        retryable=True,
    )
    provenance = SimpleNamespace(
        status=_enum("unavailable"),
        profile_id="profile-1",
        profile_spec_sha256="c" * 64,
        reason=_enum("worker_timeout"),
    )
    projection = _projection(
        status="failed",
        source=None,
        pages=[
            _page(
                status="failed",
                provenance=provenance,
                failure=failure,
            )
        ],
        provenance=provenance,
        failure=failure,
    )

    summary = build_ocr_summary(
        host_capture_id="host-capture-id",
        runtime_capture_id="runtime-capture-id",
        operation=_operation(status="failed", source=_source()),
        projection=projection,
    )
    payload = summary.model_dump(mode="json", by_alias=True)

    assert payload["failure"] == {"code": "worker_timeout", "retryable": True}
    assert payload["pages"][0]["failure"] == {
        "code": "worker_timeout",
        "retryable": True,
    }
    assert payload["provenance"] == {
        "status": "unavailable",
        "runtimeVersion": "0.4.2",
        "contractSha256": "d" * 64,
        "profileId": "profile-1",
        "profileSpecSha256": "c" * 64,
        "reason": "worker_timeout",
    }
    assert "private provider diagnostic" not in str(payload)
    assert "ocr-worker" not in str(payload)


@pytest.mark.parametrize(
    ("operation_update", "projection_update"),
    [
        (
            {"capture_id": "other-runtime-id"},
            {"capture_id": "other-runtime-id"},
        ),
        ({}, {"api_version": "1.0"}),
        ({}, {"schema_version": "2"}),
        ({}, {"capture_id": "other-runtime-id"}),
        (
            {},
            {
                "source": SimpleNamespace(
                    sha256="e" * 64,
                    file_name="private-source.pdf",
                    media_type="application/pdf",
                    bytes=1234,
                )
            },
        ),
        ({"status": SimpleNamespace(value="failed")}, {}),
    ],
)
def test_identity_schema_source_and_terminal_pair_drift_fail_closed(
    operation_update: dict[str, object],
    projection_update: dict[str, object],
) -> None:
    source = _source()
    operation = _operation(status="awaiting_structuring", source=source)
    projection = _projection(status="completed", source=source)
    for name, value in operation_update.items():
        setattr(operation, name, value)
    for name, value in projection_update.items():
        setattr(projection, name, value)

    with pytest.raises(OcrSummaryValidationError):
        build_ocr_summary(
            host_capture_id="host-capture-id",
            runtime_capture_id="runtime-capture-id",
            operation=operation,
            projection=projection,
        )


def _enum(value: str) -> SimpleNamespace:
    return SimpleNamespace(value=value)


def _source(*, sha256: str = "a" * 64) -> SimpleNamespace:
    return SimpleNamespace(
        sha256=sha256,
        file_name="private-source.pdf",
        media_type="application/pdf",
        bytes=1234,
    )


def _resolved_provenance() -> SimpleNamespace:
    return SimpleNamespace(
        status=_enum("resolved"),
        engine="windowsml-ocr",
        model="capture-ocr-model",
        model_digest="sha256:" + "b" * 64,
        device="directml:0",
        profile_id="profile-1",
        profile_spec_sha256="c" * 64,
    )


def _operation(*, status: str, source: SimpleNamespace) -> SimpleNamespace:
    return SimpleNamespace(
        capture_id="runtime-capture-id",
        status=_enum(status),
        source=source,
    )


def _page(
    *,
    page: int = 1,
    status: str,
    text: str = "",
    boxes: list[object] | None = None,
    confidence: float | None = None,
    provenance: SimpleNamespace | None = None,
    failure: SimpleNamespace | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        page=page,
        status=_enum(status),
        text=text,
        boxes=[] if boxes is None else boxes,
        confidence=confidence,
        provenance=provenance or _resolved_provenance(),
        failure=failure,
    )


def _projection(
    *,
    status: str,
    source: SimpleNamespace | None,
    pages: list[SimpleNamespace] | None = None,
    provenance: SimpleNamespace | None = None,
    failure: SimpleNamespace | None = None,
) -> SimpleNamespace:
    projection_pages = pages or [
        _page(status="recognized", text="recognized", confidence=0.75)
    ]
    return SimpleNamespace(
        api_version="2.0",
        schema_version="3",
        capture_id="runtime-capture-id",
        status=_enum(status),
        source=source,
        pages=projection_pages,
        page_count=len(projection_pages),
        runtime_version="0.4.2",
        contract_sha256="d" * 64,
        provenance=provenance or _resolved_provenance(),
        failure=failure,
    )
