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

from conftest import AUTH_TOKEN, minimal_audio, minimal_image, minimal_pdf
from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.capture_workbench.client import CaptureUpload
from cert_prep_backend.domains.capture_workbench.contracts import (
    CaptureDocumentV1,
    CaptureJobV1,
    CaptureSourceKind,
    RawCaptureV1,
)
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
        assert json_schema["title"] == "_CaptureBlockBatchV1"
        assert num_ctx > num_predict > 0
        prompt = json.loads(messages[1]["content"])
        blocks = [
            {
                "blockId": f"block-{segment['segmentId']}",
                "order": segment["order"],
                "type": "transcript" if segment["locator"]["kind"] == "time" else "paragraph",
                "sourceSegmentId": segment["segmentId"],
                "locator": segment["locator"],
                "sourceText": segment["text"],
                "targetText": segment["text"],
            }
            for segment in prompt["rawSegments"]
        ]
        return json.dumps({"blocks": blocks})


class DeterministicCaptureRuntime:
    expected_source_kind = CaptureSourceKind.PDF

    def __init__(self) -> None:
        self.raw: RawCaptureV1 | None = None
        self.result: CaptureDocumentV1 | None = None
        self.deleted: list[str] = []
        self.created_idempotency_keys: list[UUID] = []
        self.commit_idempotency_keys: list[UUID] = []

    def handshake(self) -> None:
        return None

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


class RequirementUnavailablePdfCaptureRuntime(DeterministicCaptureRuntime):
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
                "captureId": "capture-requirement-unavailable",
                "status": "failed",
                "stage": "failed",
                "structuringMode": "host",
                "progress": 1,
                "source": self.raw.source.model_dump(mode="json", by_alias=True),
                "error": {
                    "code": "requirement_unavailable",
                    "message": "A required extractor is unavailable.",
                    "stage": "extracting",
                    "retryable": False,
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
    runtime = RequirementUnavailablePdfCaptureRuntime()
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
