from __future__ import annotations

from datetime import UTC, datetime
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from threading import Event
import time
from pathlib import Path
from uuid import UUID

from fastapi.testclient import TestClient
import pytest

from conftest import (
    AUTH_TOKEN,
    _test_runtime_ready,
    _test_runtime_requirements,
    minimal_audio,
    minimal_image,
    minimal_pdf,
)
from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.capture_workbench.client import CaptureUpload
from capture_contracts import (
    CaptureDocumentV1,
    CaptureJobV1,
    CaptureSourceKind,
    RawCaptureV1,
    RuntimeRequirementsV1,
)
from cert_prep_backend.domains.capture_workbench.host_models import RuntimeReadyV1
from cert_prep_backend.domains.capture_workbench.runtime_policy import LEGACY_CORE_ONLY_RUNTIME_VERSION
from document_test_helpers import _create_project
from document_test_llm_fakes import MockExamProvider


NOW = datetime(2026, 7, 20, 5, 0, tzinfo=UTC)


class EchoCaptureProvider(MockExamProvider):
    provider = "existing-cert-provider"
    model = "cert-model"

    def generate_structured_json(
        self,
        *,
        messages,
        json_schema,
        num_ctx,
        num_predict,
    ) -> str:
        assert json_schema["title"] == "CaptureBlockBatchV1"
        assert num_ctx > num_predict > 0
        prompt = json.loads(messages[1]["content"])
        blocks = [
            {
                "type": "transcript" if segment["locator"]["kind"] == "time" else "paragraph",
                "sourceSegmentId": segment["segmentId"],
                "targetText": segment["text"],
            }
            for segment in prompt["rawSegments"]
        ]
        return json.dumps({"blocks": blocks})


class DeterministicCaptureRuntime:
    expected_source_kind = CaptureSourceKind.PDF

    def __init__(self, *, runtime_version: str = "0.3.9") -> None:
        self.runtime_version = runtime_version
        self.raw: RawCaptureV1 | None = None
        self.result: CaptureDocumentV1 | None = None
        self.deleted: list[str] = []
        self.created_idempotency_keys: list[UUID] = []
        self.commit_idempotency_keys: list[UUID] = []

    def handshake(self) -> RuntimeReadyV1:
        return _test_runtime_ready().model_copy(
            update={"runtime_version": self.runtime_version}
        )

    def get_requirements(self) -> RuntimeRequirementsV1:
        return _test_runtime_requirements("ready")

    def create_capture(
        self,
        upload: CaptureUpload,
        *,
        source_kind: CaptureSourceKind,
        idempotency_key: UUID,
        target_language: str | None = None,
    ) -> CaptureJobV1:
        assert source_kind is self.expected_source_kind
        assert target_language is None
        assert isinstance(upload.content, bytes)
        self.created_idempotency_keys.append(idempotency_key)
        self.raw = RawCaptureV1.model_validate(
            {
                "schemaVersion": "1",
                "diagnosticOnly": True,
                "source": {
                    "sha256": hashlib.sha256(upload.content).hexdigest(),
                    "fileName": upload.file_name,
                    "mediaType": upload.media_type,
                    "bytes": len(upload.content),
                },
                "segments": [
                    {
                        "segmentId": "page-1",
                        "order": 0,
                        "locator": {"kind": "page", "page": 1},
                        "text": "Sidecar extracted source text",
                    }
                ],
                "sourceText": "Sidecar extracted source text",
                "extractionEngine": {
                    "engine": "windowsml-ocr",
                    "model": "capture-ocr-v1",
                    "digest": f"sha256:{'b' * 64}",
                    "device": "igpu",
                },
                "warnings": [],
                "createdAt": NOW.isoformat(),
            }
        )
        return self._job(status="running", stage="awaiting_structuring")

    def get_raw(self, _capture_id: str) -> RawCaptureV1:
        assert self.raw is not None
        return self.raw

    def commit_structure(
        self,
        _capture_id: str,
        candidate: object,
        *,
        idempotency_key: UUID,
    ) -> CaptureJobV1:
        self.commit_idempotency_keys.append(idempotency_key)
        self.result = (
            CaptureDocumentV1.model_validate_json(candidate)
            if isinstance(candidate, str)
            else CaptureDocumentV1.model_validate(candidate)
        )
        assert self.raw is not None
        assert self.result.source == self.raw.source
        assert self.result.raw_segments == self.raw.segments
        return self._job(status="completed", stage="completed")

    def get_result(self, _capture_id: str) -> CaptureDocumentV1:
        assert self.result is not None
        return self.result

    def get_capture(self, _capture_id: str) -> CaptureJobV1:
        return self._job(status="running", stage="awaiting_structuring")

    def report_structuring_failure(self, *_args, **_kwargs):
        raise AssertionError("host provider should succeed")

    def cancel_capture(self, *_args, **_kwargs):
        raise AssertionError("capture should not be cancelled")

    def delete_capture(self, capture_id: str) -> None:
        self.deleted.append(capture_id)

    def _job(self, *, status: str, stage: str) -> CaptureJobV1:
        assert self.raw is not None
        return CaptureJobV1.model_validate(
            {
                "captureId": "capture-pipeline-1",
                "status": status,
                "stage": stage,
                "structuringMode": "host",
                "progress": 1 if status == "completed" else 0.7,
                "source": self.raw.source.model_dump(mode="json", by_alias=True),
                "error": None,
                "createdAt": NOW.isoformat(),
                "updatedAt": NOW.isoformat(),
                "completedAt": NOW.isoformat() if status == "completed" else None,
            }
        )


class CoreOnlyPdfExtractionFailedRuntime(DeterministicCaptureRuntime):
    def __init__(self) -> None:
        super().__init__(runtime_version=LEGACY_CORE_ONLY_RUNTIME_VERSION)
        self.requirement_reads = 0

    def get_requirements(self) -> RuntimeRequirementsV1:
        self.requirement_reads += 1
        requirements = _test_runtime_requirements("unavailable")
        detail = "No downloadable model is published for this runtime release."
        return requirements.model_copy(
            update={
                "items": [
                    item.model_copy(update={"detail": detail})
                    for item in requirements.items
                ]
            }
        )

    def create_capture(
        self,
        upload: CaptureUpload,
        *,
        source_kind: CaptureSourceKind,
        idempotency_key: UUID,
        target_language: str | None = None,
    ) -> CaptureJobV1:
        super().create_capture(
            upload,
            source_kind=source_kind,
            idempotency_key=idempotency_key,
            target_language=target_language,
        )
        assert self.raw is not None
        return CaptureJobV1.model_validate(
            {
                "captureId": "capture-core-only-extraction-failed",
                "status": "failed",
                "stage": "failed",
                "structuringMode": "host",
                "progress": 1,
                "source": self.raw.source.model_dump(mode="json", by_alias=True),
                "error": {
                    "code": "extraction_failed",
                    "message": "Source extraction failed.",
                    "stage": "extraction",
                    "retryable": True,
                },
                "createdAt": NOW.isoformat(),
                "updatedAt": NOW.isoformat(),
                "completedAt": NOW.isoformat(),
            }
        )


class BlockingDeterministicCaptureRuntime(DeterministicCaptureRuntime):
    def __init__(self) -> None:
        super().__init__()
        self.commit_started = Event()
        self.release_commit = Event()

    def commit_structure(
        self,
        capture_id: str,
        candidate: object,
        *,
        idempotency_key: UUID,
    ) -> CaptureJobV1:
        self.commit_started.set()
        if not self.release_commit.wait(timeout=5):
            raise AssertionError("blocking capture runtime was not released")
        return super().commit_structure(
            capture_id,
            candidate,
            idempotency_key=idempotency_key,
        )


class DeterministicImageCaptureRuntime(DeterministicCaptureRuntime):
    expected_source_kind = CaptureSourceKind.IMAGE


class DeterministicAudioCaptureRuntime(DeterministicCaptureRuntime):
    def create_capture(
        self,
        upload: CaptureUpload,
        *,
        source_kind: CaptureSourceKind,
        idempotency_key: UUID,
        target_language: str | None = None,
    ) -> CaptureJobV1:
        assert source_kind is CaptureSourceKind.AUDIO
        assert target_language == "zh-Hant"
        assert isinstance(upload.content, bytes)
        self.created_idempotency_keys.append(idempotency_key)
        self.raw = RawCaptureV1.model_validate(
            {
                "schemaVersion": "1",
                "diagnosticOnly": True,
                "source": {
                    "sha256": hashlib.sha256(upload.content).hexdigest(),
                    "fileName": upload.file_name,
                    "mediaType": upload.media_type,
                    "bytes": len(upload.content),
                },
                "segments": [
                    {
                        "segmentId": "time-1",
                        "order": 0,
                        "locator": {"kind": "time", "startMs": 50, "endMs": 900},
                        "text": "Audio source text",
                    }
                ],
                "sourceText": "Audio source text",
                "extractionEngine": {
                    "engine": "faster-whisper",
                    "model": "whisper-primary",
                    "digest": f"sha256:{'e' * 64}",
                    "device": "cpu",
                },
                "warnings": ["GPU unavailable; used CPU."],
                "createdAt": NOW.isoformat(),
            }
        )
        return self._job(status="running", stage="awaiting_structuring")


class CoreOnlyCaptureRuntime(DeterministicCaptureRuntime):
    def __init__(self) -> None:
        super().__init__(runtime_version=LEGACY_CORE_ONLY_RUNTIME_VERSION)
        self.create_attempts = 0
        self.requirement_reads = 0

    def get_requirements(self) -> RuntimeRequirementsV1:
        self.requirement_reads += 1
        requirements = _test_runtime_requirements("unavailable")
        detail = "No downloadable model is published for this runtime release."
        return requirements.model_copy(
            update={
                "items": [
                    item.model_copy(update={"detail": detail})
                    for item in requirements.items
                ]
            }
        )

    def create_capture(self, *args, **kwargs) -> CaptureJobV1:
        self.create_attempts += 1
        return super().create_capture(*args, **kwargs)


def test_upload_delegates_to_capture_runtime_and_atomically_maps_existing_chunks(
    tmp_path: Path,
) -> None:
    runtime = DeterministicCaptureRuntime()
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    with TestClient(
        create_app(
            settings=settings,
            llm_provider=EchoCaptureProvider(),
            capture_runtime_client=runtime,
            document_processing_async_jobs=False,
            streaming_draft_generation_async_jobs=False,
        )
    ) as client:
        headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, headers)
        source = minimal_pdf("Legacy extractor must not own this result.")

        response = client.post(
            f"/projects/{project_id}/documents",
            headers=headers,
            data={"language_hint": "ja"},
            files={"file": ("capture.pdf", source, "application/pdf")},
        )

        assert response.status_code == 201
        document = response.json()
        assert document["status"] == "ready"
        assert document["sha256"] == hashlib.sha256(source).hexdigest()
        assert document["extraction_method"] == "windowsml_ocr"
        assert document["ocr_device"] == "igpu"
        assert document["chunks_count"] == 1
        chunks = client.get(
            f"/projects/{project_id}/documents/{document['id']}/chunks",
            headers=headers,
        ).json()["items"]
        assert chunks[0]["text"] == "Sidecar extracted source text"
        assert chunks[0]["page_number"] == 1

    assert runtime.deleted == ["capture-pipeline-1"]
    assert runtime.created_idempotency_keys[0] != runtime.commit_idempotency_keys[0]


def test_image_upload_uses_the_same_capture_runtime_host_path(tmp_path: Path) -> None:
    runtime = DeterministicImageCaptureRuntime()
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    with TestClient(
        create_app(
            settings=settings,
            llm_provider=EchoCaptureProvider(),
            capture_runtime_client=runtime,
            document_processing_async_jobs=False,
            streaming_draft_generation_async_jobs=False,
        )
    ) as client:
        headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, headers)
        source = minimal_image()

        response = client.post(
            f"/projects/{project_id}/documents",
            headers=headers,
            files={"file": ("capture.png", source, "image/png")},
        )

        assert response.status_code == 201
        document = response.json()
        assert document["status"] == "ready"
        assert document["source_kind"] == "document"
        assert document["extraction_method"] == "windowsml_ocr"
        chunks = client.get(
            f"/projects/{project_id}/documents/{document['id']}/chunks",
            headers=headers,
        ).json()["items"]
        assert chunks[0]["text"] == "Sidecar extracted source text"

    assert runtime.deleted == ["capture-pipeline-1"]


def test_audio_upload_uses_capture_time_provenance_without_cert_whisper(
    tmp_path: Path,
) -> None:
    runtime = DeterministicAudioCaptureRuntime()
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    with TestClient(
        create_app(
            settings=settings,
            llm_provider=EchoCaptureProvider(),
            capture_runtime_client=runtime,
            document_processing_async_jobs=False,
            streaming_draft_generation_async_jobs=False,
        )
    ) as client:
        headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, headers)
        source = minimal_audio(".wav")

        response = client.post(
            f"/projects/{project_id}/documents",
            headers=headers,
            data={"language_hint": "ja"},
            files={"file": ("capture.wav", source, "audio/wav")},
        )

        assert response.status_code == 201
        document = response.json()
        assert document["status"] == "ready"
        assert document["source_kind"] == "audio"
        assert document["transcription_status"] == "succeeded"
        assert document["translation_status"] == "succeeded"
        assert document["effective_transcription_model"] == "whisper-primary"
        assert document["duration_ms"] == 900
        chunks = client.get(
            f"/projects/{project_id}/documents/{document['id']}/chunks",
            headers=headers,
        ).json()["items"]
        assert chunks[0]["locator_kind"] == "time"
        assert chunks[0]["start_ms"] == 50
        assert chunks[0]["end_ms"] == 900
        assert chunks[0]["text"] == "Audio source text"
        assert chunks[0]["translated_text"] == "Audio source text"

    assert runtime.deleted == ["capture-pipeline-1"]


@pytest.mark.parametrize(
    (
        "filename",
        "media_type",
        "expected_document_status",
        "expected_message",
    ),
    [
        (
            "capture.png",
            "image/png",
            "ocr_failed",
            "WindowsML OCR is unavailable. No downloadable model is published for this runtime release.",
        ),
        (
            "capture.wav",
            "audio/wav",
            "transcription_failed",
            "Whisper transcription is unavailable. No downloadable model is published for this runtime release.",
        ),
    ],
)
def test_core_only_image_and_audio_fail_before_sidecar_dispatch(
    tmp_path: Path,
    filename: str,
    media_type: str,
    expected_document_status: str,
    expected_message: str,
) -> None:
    runtime = CoreOnlyCaptureRuntime()
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    operation_id = f"core-only-{filename.rsplit('.', 1)[-1]}"
    source = minimal_audio(".wav") if filename.endswith(".wav") else minimal_image()
    with TestClient(
        create_app(
            settings=settings,
            llm_provider=EchoCaptureProvider(),
            capture_runtime_client=runtime,
            document_processing_async_jobs=False,
            streaming_draft_generation_async_jobs=False,
        )
    ) as client:
        headers = {
            "Authorization": f"Bearer {AUTH_TOKEN}",
            "X-Cert-Prep-Operation-Id": operation_id,
        }
        project_id = _create_project(
            client, {"Authorization": f"Bearer {AUTH_TOKEN}"}
        )

        response = client.post(
            f"/projects/{project_id}/documents",
            headers=headers,
            files={"file": (filename, source, media_type)},
        )

        assert response.status_code == 503
        assert response.json() == {
            "code": "capture_runtime_unavailable",
            "message": expected_message,
        }
        operation = client.get(
            f"/projects/{project_id}/document-operations/{operation_id}",
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"},
        ).json()
        assert operation["status"] == "failed"
        assert operation["error"] == expected_message
        documents = client.get(
            f"/projects/{project_id}/documents",
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"},
        ).json()["items"]
        assert len(documents) == 1
        assert documents[0]["status"] == expected_document_status
        assert documents[0]["chunks_count"] == 0

    assert runtime.requirement_reads == 1
    assert runtime.create_attempts == 0
    assert runtime.deleted == []


def test_core_only_ocr_dependent_pdf_dispatches_then_reports_explicit_failure(
    tmp_path: Path,
) -> None:
    runtime = CoreOnlyPdfExtractionFailedRuntime()
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    operation_id = "core-only-ocr-pdf"
    expected_message = (
        "This PDF requires WindowsML OCR, which is unavailable in the installed "
        "Capture Runtime."
    )
    with TestClient(
        create_app(
            settings=settings,
            llm_provider=EchoCaptureProvider(),
            capture_runtime_client=runtime,
            document_processing_async_jobs=False,
            streaming_draft_generation_async_jobs=False,
        )
    ) as client:
        auth_headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, auth_headers)
        response = client.post(
            f"/projects/{project_id}/documents",
            headers={
                **auth_headers,
                "X-Cert-Prep-Operation-Id": operation_id,
            },
            files={
                "file": (
                    "scanned.pdf",
                    minimal_pdf("Runtime classifies OCR dependency."),
                    "application/pdf",
                )
            },
        )

        assert response.status_code == 503
        assert response.json() == {
            "code": "capture_runtime_unavailable",
            "message": expected_message,
        }
        operation = client.get(
            f"/projects/{project_id}/document-operations/{operation_id}",
            headers=auth_headers,
        ).json()
        assert operation["status"] == "failed"
        assert operation["error"] == expected_message
        documents = client.get(
            f"/projects/{project_id}/documents", headers=auth_headers
        ).json()["items"]
        assert documents[0]["status"] == "ocr_failed"
        assert documents[0]["chunks_count"] == 0

    assert runtime.created_idempotency_keys
    assert runtime.requirement_reads == 1


def test_async_core_only_pdf_failure_reaches_durable_terminal_state(
    tmp_path: Path,
) -> None:
    runtime = CoreOnlyPdfExtractionFailedRuntime()
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    operation_id = "async-core-only-ocr-pdf"
    expected_message = (
        "This PDF requires WindowsML OCR, which is unavailable in the installed "
        "Capture Runtime."
    )
    with TestClient(
        create_app(
            settings=settings,
            llm_provider=EchoCaptureProvider(),
            capture_runtime_client=runtime,
            document_processing_async_jobs=True,
            streaming_draft_generation_async_jobs=False,
        )
    ) as client:
        auth_headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, auth_headers)
        response = client.post(
            f"/projects/{project_id}/documents",
            headers={
                **auth_headers,
                "X-Cert-Prep-Operation-Id": operation_id,
            },
            files={
                "file": (
                    "scanned.pdf",
                    minimal_pdf("Runtime classifies OCR dependency."),
                    "application/pdf",
                )
            },
        )

        assert response.status_code == 201
        operation = None
        for _ in range(100):
            operation = client.get(
                f"/projects/{project_id}/document-operations/{operation_id}",
                headers=auth_headers,
            ).json()
            if operation["status"] == "failed":
                break
            time.sleep(0.01)
        assert operation is not None
        assert operation["status"] == "failed"
        assert operation["error"] == expected_message
        document = client.get(
            f"/projects/{project_id}/documents/{response.json()['id']}",
            headers=auth_headers,
        ).json()
        assert document["status"] == "ocr_failed"
        assert document["chunks_count"] == 0

    assert runtime.created_idempotency_keys
    assert runtime.requirement_reads == 1


def test_review_capture_pauses_before_persistence_and_applies_confirmed_overlay(
    tmp_path: Path,
) -> None:
    runtime = DeterministicCaptureRuntime()
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    with TestClient(
        create_app(
            settings=settings,
            llm_provider=EchoCaptureProvider(),
            capture_runtime_client=runtime,
            document_processing_async_jobs=False,
            streaming_draft_generation_async_jobs=False,
        )
    ) as client:
        headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, headers)
        source = minimal_pdf("Review before save.")

        created = client.post(
            f"/projects/{project_id}/capture-workbench/captures",
            headers=headers,
            files={"file": ("review.pdf", source, "application/pdf")},
        )

        assert created.status_code == 202
        capture = created.json()
        capture_id = capture["captureId"]
        assert capture["status"] == "queued"

        pending_document = client.get(
            f"/projects/{project_id}/documents/{capture['documentId']}",
            headers=headers,
        ).json()
        assert pending_document["status"] == "processing"
        assert pending_document["chunks_count"] == 0

        pending = _wait_for_capture_stage(
            client,
            project_id=project_id,
            capture_id=capture_id,
            headers=headers,
            stage="awaiting_structuring",
        )
        assert pending.status_code == 200
        assert pending.json()["captureId"] == capture_id
        assert pending.json()["stage"] == "awaiting_structuring"
        raw = client.get(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/raw",
            headers=headers,
        )
        assert raw.status_code == 200
        assert raw.json()["segments"][0]["text"] == "Sidecar extracted source text"
        assert (
            client.get(
                f"/projects/{project_id}/capture-workbench/captures/{capture_id}/result",
                headers=headers,
            ).status_code
            == 409
        )

        invalid_review = client.post(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/confirm",
            headers=headers,
            json={
                "clientRequestId": "review-confirm-invalid",
                "review": {
                    "reviewVersion": 1,
                    "edits": [{"segmentId": "not-a-runtime-segment", "reviewedText": "x"}],
                },
            },
        )
        assert invalid_review.status_code == 422

        confirmed = client.post(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/confirm",
            headers=headers,
            json={
                "clientRequestId": "review-confirm-1",
                "review": {
                    "reviewVersion": 1,
                    "edits": [{"segmentId": "page-1", "reviewedText": "Corrected OCR text"}],
                },
            },
        )
        assert confirmed.status_code == 202
        assert confirmed.json()["stage"] == "structuring"

        _wait_for_capture_stage(
            client,
            project_id=project_id,
            capture_id=capture_id,
            headers=headers,
            stage="completed",
        )
        result = client.get(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/result",
            headers=headers,
        )
        assert result.status_code == 200
        assert result.json()["rawSegments"][0]["text"] == "Sidecar extracted source text"
        assert result.json()["blocks"][0]["targetText"] == "Corrected OCR text"

        saved = client.get(
            f"/projects/{project_id}/documents/{capture['documentId']}/chunks",
            headers=headers,
        )
        assert saved.status_code == 200
        assert saved.json()["items"][0]["raw_text"] == "Sidecar extracted source text"
        assert saved.json()["items"][0]["text"] == "Corrected OCR text"

        cancel_completed = client.post(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/cancel",
            headers=headers,
        )
        assert cancel_completed.status_code == 200
        assert cancel_completed.json()["status"] == "completed"
        assert cancel_completed.json()["stage"] == "completed"

    assert runtime.deleted == ["capture-pipeline-1"]


def test_pdf_capture_requirement_unavailable_reports_ocr_required_failure(
    tmp_path: Path,
) -> None:
    runtime = CoreOnlyPdfExtractionFailedRuntime()
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    app = create_app(
        settings=settings,
        llm_provider=EchoCaptureProvider(),
        capture_runtime_client=runtime,
        document_processing_async_jobs=False,
        streaming_draft_generation_async_jobs=False,
    )
    operation_id = "requirement-unavailable-pdf"
    with TestClient(app) as client:
        headers = {
            "Authorization": f"Bearer {AUTH_TOKEN}",
            "X-Cert-Prep-Operation-Id": operation_id,
        }
        project_id = _create_project(client, {"Authorization": f"Bearer {AUTH_TOKEN}"})
        response = client.post(
            f"/projects/{project_id}/capture-workbench/captures",
            headers=headers,
            files={"file": ("scanned.pdf", minimal_pdf("Scanned source."), "application/pdf")},
        )
        assert response.status_code == 202

        operation = None
        for _ in range(100):
            with app.state.database.connect() as connection:
                operation = connection.execute(
                    "SELECT status, phase, error FROM document_operations WHERE id = ?",
                    (operation_id,),
                ).fetchone()
            if operation is not None and operation[0] == "failed":
                break
            time.sleep(0.01)

    assert operation is not None
    assert tuple(operation) == (
        "failed",
        "failed",
        "This PDF requires WindowsML OCR, which is unavailable in the installed Capture Runtime.",
    )
    assert runtime.requirement_reads == 1


def test_expired_review_is_canceled_and_terminal_cancel_is_idempotent(tmp_path: Path) -> None:
    runtime = DeterministicCaptureRuntime()
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    app = create_app(
        settings=settings,
        llm_provider=EchoCaptureProvider(),
        capture_runtime_client=runtime,
        document_processing_async_jobs=False,
        streaming_draft_generation_async_jobs=False,
    )
    with TestClient(app) as client:
        headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, headers)
        created = client.post(
            f"/projects/{project_id}/capture-workbench/captures",
            headers=headers,
            files={"file": ("expired.pdf", minimal_pdf("Expire this review."), "application/pdf")},
        )
        assert created.status_code == 202
        capture_id = created.json()["captureId"]
        _wait_for_capture_stage(
            client,
            project_id=project_id,
            capture_id=capture_id,
            headers=headers,
            stage="awaiting_structuring",
        )

        with app.state.database.connect() as connection:
            connection.execute(
                "UPDATE capture_review_sessions SET expires_at = ? WHERE id = ?",
                ("2000-01-01T00:00:00+00:00", capture_id),
            )

        expired = client.get(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}",
            headers=headers,
        )
        assert expired.status_code == 200
        assert expired.json()["status"] == "cancelled"
        assert expired.json()["stage"] == "cancelled"

        cancel_again = client.post(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/cancel",
            headers=headers,
        )
        assert cancel_again.status_code == 200
        assert cancel_again.json()["status"] == "cancelled"


def test_confirmation_request_is_atomic_idempotent_and_rejects_divergent_replay(
    tmp_path: Path,
) -> None:
    runtime = BlockingDeterministicCaptureRuntime()
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    app = create_app(
        settings=settings,
        llm_provider=EchoCaptureProvider(),
        capture_runtime_client=runtime,
        document_processing_async_jobs=True,
        streaming_draft_generation_async_jobs=False,
    )
    with TestClient(app) as client:
        headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, headers)
        source = minimal_pdf("Confirm exactly once.")
        created = client.post(
            f"/projects/{project_id}/capture-workbench/captures",
            headers=headers,
            files={"file": ("confirm-once.pdf", source, "application/pdf")},
        )
        assert created.status_code == 202
        capture_id = created.json()["captureId"]
        _wait_for_capture_stage(
            client,
            project_id=project_id,
            capture_id=capture_id,
            headers=headers,
            stage="awaiting_structuring",
        )
        review = {
            "reviewVersion": 1,
            "edits": [{"segmentId": "page-1", "reviewedText": "Confirmed once"}],
        }
        first = client.post(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/confirm",
            headers=headers,
            json={"clientRequestId": "confirm-once", "review": review},
        )
        assert first.status_code == 202
        assert runtime.commit_started.wait(timeout=2)

        replay = client.post(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/confirm",
            headers=headers,
            json={"clientRequestId": "confirm-once", "review": review},
        )
        assert replay.status_code == 202
        assert replay.json()["stage"] == "structuring"

        divergent = client.post(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/confirm",
            headers=headers,
            json={
                "clientRequestId": "confirm-once",
                "review": {
                    "reviewVersion": 1,
                    "edits": [{"segmentId": "page-1", "reviewedText": "Changed replay"}],
                },
            },
        )
        assert divergent.status_code == 409

        runtime.release_commit.set()
        completed = _wait_for_capture_stage(
            client,
            project_id=project_id,
            capture_id=capture_id,
            headers=headers,
            stage="completed",
        )
        assert completed.status_code == 200


def test_failed_capture_upload_finishes_claimed_operation(tmp_path: Path) -> None:
    runtime = DeterministicCaptureRuntime()
    settings = Settings(
        data_dir=tmp_path,
        api_token=AUTH_TOKEN,
        llm_provider="fake",
        max_upload_bytes=32,
    )
    app = create_app(
        settings=settings,
        llm_provider=EchoCaptureProvider(),
        capture_runtime_client=runtime,
        document_processing_async_jobs=False,
        streaming_draft_generation_async_jobs=False,
    )
    operation_id = "oversized-capture"
    with TestClient(app) as client:
        headers = {
            "Authorization": f"Bearer {AUTH_TOKEN}",
            "X-Cert-Prep-Operation-Id": operation_id,
        }
        project_id = _create_project(client, {"Authorization": f"Bearer {AUTH_TOKEN}"})
        response = client.post(
            f"/projects/{project_id}/capture-workbench/captures",
            headers=headers,
            files={"file": ("too-large.pdf", b"x" * 64, "application/pdf")},
        )
        assert response.status_code == 422

        with app.state.database.connect() as connection:
            operation = connection.execute(
                "SELECT status, phase, document_id FROM document_operations WHERE id = ?",
                (operation_id,),
            ).fetchone()
        assert operation is not None
        assert tuple(operation) == ("failed", "failed", None)


def test_same_operation_id_cannot_start_two_capture_uploads(tmp_path: Path) -> None:
    runtime = DeterministicCaptureRuntime()
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    app = create_app(
        settings=settings,
        llm_provider=EchoCaptureProvider(),
        capture_runtime_client=runtime,
        document_processing_async_jobs=False,
        streaming_draft_generation_async_jobs=False,
    )
    with TestClient(app) as client:
        auth_headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, auth_headers)

        def upload() -> int:
            response = client.post(
                f"/projects/{project_id}/capture-workbench/captures",
                headers={
                    **auth_headers,
                    "X-Cert-Prep-Operation-Id": "same-operation",
                },
                files={
                    "file": ("same-operation.pdf", minimal_pdf("One claim."), "application/pdf")
                },
            )
            return response.status_code

        with ThreadPoolExecutor(max_workers=2) as executor:
            statuses = sorted(executor.map(lambda _index: upload(), range(2)))
        assert statuses == [202, 409]


def _wait_for_capture_stage(
    client: TestClient,
    *,
    project_id: str,
    capture_id: str,
    headers: dict[str, str],
    stage: str,
) -> object:
    endpoint = f"/projects/{project_id}/capture-workbench/captures/{capture_id}"
    for _ in range(100):
        response = client.get(endpoint, headers=headers)
        if response.status_code == 200 and response.json()["stage"] == stage:
            return response
        time.sleep(0.01)
    raise AssertionError(f"Capture did not reach stage {stage!r}; last response={response.text}")
