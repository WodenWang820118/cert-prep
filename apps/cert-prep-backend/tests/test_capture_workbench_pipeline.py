from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
import gc
import hashlib
import json
from threading import Event
import time
from pathlib import Path
from uuid import UUID
import weakref

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
from cert_prep_backend.domains.capture_workbench.client import (
    CaptureRuntimeError,
    CaptureRuntimeProtocolError,
    CaptureStreamingResult,
    CaptureUpload,
)
from cert_prep_backend.domains.capture_workbench import review_workflow
from capture_contracts import (
    CAPTURE_RUNTIME_VERSION,
    CaptureDocumentV1,
    CaptureEventV2,
    CaptureOperationV2,
    CaptureSourceKind,
    PartialCaptureV2,
    RawCaptureV1,
    RuntimeRequirementsV1,
)
from cert_prep_backend.domains.capture_workbench.host_models import RuntimeReadyV1
from cert_prep_backend.domains.capture_workbench.runtime_policy import LEGACY_CORE_ONLY_RUNTIME_VERSION
from cert_prep_backend.routers.capture_workbench import CaptureRuntimeEventRegistry
from document_test_helpers import _create_project
from document_test_llm_fakes import MockExamProvider


NOW = datetime(2026, 7, 20, 5, 0, tzinfo=UTC)


def test_runtime_event_registry_wakes_listeners_without_retaining_capture_identity() -> None:
    class RegistryIdentity(str):
        pass

    registry = CaptureRuntimeEventRegistry()
    identities = [RegistryIdentity(f"capture-{index}") for index in range(128)]
    identity_references = [weakref.ref(identity) for identity in identities]
    for identity in identities:
        registry.publish_runtime(identity, identity, identity)

    identities.clear()
    del identity
    gc.collect()

    assert all(reference() is None for reference in identity_references)

    observed_revision = registry.revision()
    with ThreadPoolExecutor(max_workers=2) as executor:
        listeners = [
            executor.submit(
                registry.wait_for_change,
                observed_revision,
                timeout_seconds=1,
            )
            for _index in range(2)
        ]
        registry.publish_terminal("project", "capture", "completed")
        listener_revisions = [listener.result(timeout=2) for listener in listeners]

    assert all(revision > observed_revision for revision in listener_revisions)
    latest_revision = registry.revision()
    assert (
        registry.wait_for_change(latest_revision, timeout_seconds=0.01)
        == latest_revision
    )


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

    def __init__(self, *, runtime_version: str = CAPTURE_RUNTIME_VERSION) -> None:
        self.runtime_version = runtime_version
        self.raw: RawCaptureV1 | None = None
        self.result: CaptureDocumentV1 | None = None
        self.deleted: list[str] = []
        self.created_request_ids: list[str] = []
        self.commit_idempotency_keys: list[UUID] = []

    def handshake(self) -> RuntimeReadyV1:
        return _test_runtime_ready().model_copy(
            update={"runtime_version": self.runtime_version}
        )

    def get_requirements(self) -> RuntimeRequirementsV1:
        return _test_runtime_requirements("ready")

    def start_capture(
        self,
        upload: CaptureUpload,
        *,
        source_kind: CaptureSourceKind,
        client_request_id: str,
        target_language: str | None = None,
    ) -> CaptureOperationV2:
        assert source_kind is self.expected_source_kind
        assert target_language is None
        assert isinstance(upload.content, bytes)
        self.created_request_ids.append(client_request_id)
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
        return self._operation(status="awaiting_structuring")

    def get_partial(self, capture_id: str) -> PartialCaptureV2:
        assert self.raw is not None
        return PartialCaptureV2.model_validate(
            {
                "protocolVersion": "2",
                "captureId": capture_id,
                "source": self.raw.source.model_dump(mode="json", by_alias=True),
                "revision": 1,
                "coveredUntilMs": 0,
                "segments": [
                    segment.model_dump(mode="json", by_alias=True)
                    for segment in self.raw.segments
                ],
                "sourceText": self.raw.source_text,
                "extractionEngine": self.raw.extraction_engine.model_dump(
                    mode="json", by_alias=True
                ),
                "updatedAt": self.raw.created_at,
            }
        )

    def get_raw(self, _capture_id: str) -> RawCaptureV1:
        assert self.raw is not None
        return self.raw

    def commit_structure(
        self,
        _capture_id: str,
        candidate: object,
        *,
        idempotency_key: UUID,
    ) -> CaptureOperationV2:
        self.commit_idempotency_keys.append(idempotency_key)
        self.result = (
            CaptureDocumentV1.model_validate_json(candidate)
            if isinstance(candidate, str)
            else CaptureDocumentV1.model_validate(candidate)
        )
        assert self.raw is not None
        assert self.result.source == self.raw.source
        assert self.result.raw_segments == self.raw.segments
        return self._operation(status="completed")

    def get_result(self, _capture_id: str) -> CaptureStreamingResult:
        assert self.raw is not None
        assert self.result is not None
        return CaptureStreamingResult(
            operation=self._operation(status="completed"),
            raw=self.raw,
            result=self.result,
        )

    def get_capture(self, _capture_id: str) -> CaptureOperationV2:
        return self._operation(
            status="completed" if self.result is not None else "awaiting_structuring"
        )

    def report_structuring_failure(self, *_args, **_kwargs):
        raise AssertionError("host provider should succeed")

    def cancel_capture(self, *_args, **_kwargs):
        raise AssertionError("capture should not be cancelled")

    def delete_capture(self, capture_id: str) -> None:
        self.deleted.append(capture_id)

    def _operation(self, *, status: str) -> CaptureOperationV2:
        assert self.raw is not None
        terminal = status in {"completed", "failed", "cancelled"}
        error = (
            {
                "code": "extraction_failed",
                "message": "Source extraction failed.",
                "stage": "extraction",
                "retryable": True,
            }
            if status == "failed"
            else None
        )
        return CaptureOperationV2.model_validate(
            {
                "protocolVersion": "2",
                "captureId": "capture-pipeline-1",
                "ingestionId": "ingestion-pipeline-1",
                "kind": self.expected_source_kind.value,
                "status": status,
                "progress": 1 if terminal else 0.7,
                "partialRevision": 1,
                "lastEventSequence": 1,
                "source": self.raw.source.model_dump(mode="json", by_alias=True),
                "error": error,
                "createdAt": NOW.isoformat(),
                "updatedAt": NOW.isoformat(),
                "completedAt": NOW.isoformat() if terminal else None,
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

    def start_capture(
        self,
        upload: CaptureUpload,
        *,
        source_kind: CaptureSourceKind,
        client_request_id: str,
        target_language: str | None = None,
    ) -> CaptureOperationV2:
        super().start_capture(
            upload,
            source_kind=source_kind,
            client_request_id=client_request_id,
            target_language=target_language,
        )
        assert self.raw is not None
        failed = self._operation(status="failed")
        return CaptureOperationV2.model_validate(
            {
                **failed.model_dump(mode="json", by_alias=True),
                "captureId": "capture-core-only-extraction-failed",
            }
        )


class PendingTerminalRaceCaptureRuntime(DeterministicCaptureRuntime):
    def __init__(self) -> None:
        super().__init__()
        self.listener_waiting = Event()
        self.release_terminal_event = Event()

    def start_capture(
        self,
        upload: CaptureUpload,
        *,
        source_kind: CaptureSourceKind,
        client_request_id: str,
        target_language: str | None = None,
    ) -> CaptureOperationV2:
        admitted = super().start_capture(
            upload,
            source_kind=source_kind,
            client_request_id=client_request_id,
            target_language=target_language,
        )
        return CaptureOperationV2.model_validate(
            {
                **admitted.model_dump(mode="json", by_alias=True),
                "status": "extracting",
                "progress": 0.3,
                "lastEventSequence": 0,
            }
        )

    def capture_events(
        self,
        capture_id: str,
        *,
        last_event_id: str | int | None = None,
        on_activity=None,
    ):
        assert last_event_id == 0
        self.listener_waiting.set()
        if not self.release_terminal_event.wait(timeout=5):
            raise AssertionError("test did not release terminal extraction event")
        if on_activity is not None:
            on_activity()
        failed = self.get_capture(capture_id)
        yield CaptureEventV2.model_validate(
            {
                "protocolVersion": "2",
                "eventId": f"{capture_id}/1",
                "sequence": 1,
                "captureId": capture_id,
                "kind": "pdf",
                "eventType": "failed",
                "stage": "failed",
                "progress": 1,
                "partialRevision": 1,
                "segments": [],
                "error": failed.error.model_dump(mode="json", by_alias=True),
                "createdAt": NOW.isoformat(),
            }
        )

    def get_capture(self, _capture_id: str) -> CaptureOperationV2:
        return self._operation(status="failed")


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
    ) -> CaptureOperationV2:
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


class InvalidResultReplayCaptureRuntime(DeterministicCaptureRuntime):
    def __init__(self) -> None:
        super().__init__()
        self.result_reads = 0

    def get_result(self, capture_id: str) -> CaptureStreamingResult:
        self.result_reads += 1
        if self.result_reads > 1:
            raise CaptureRuntimeProtocolError(
                "Capture Runtime returned a mismatched result source"
            )
        return super().get_result(capture_id)


class DeterministicAudioCaptureRuntime(DeterministicCaptureRuntime):
    expected_source_kind = CaptureSourceKind.AUDIO

    def start_capture(
        self,
        upload: CaptureUpload,
        *,
        source_kind: CaptureSourceKind,
        client_request_id: str,
        target_language: str | None = None,
    ) -> CaptureOperationV2:
        assert source_kind is CaptureSourceKind.AUDIO
        assert target_language == "zh-Hant"
        assert isinstance(upload.content, bytes)
        self.created_request_ids.append(client_request_id)
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
        return self._operation(status="awaiting_structuring")


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

    def start_capture(self, *args, **kwargs) -> CaptureOperationV2:
        self.create_attempts += 1
        return super().start_capture(*args, **kwargs)


class ReplayableEventCaptureRuntime(DeterministicCaptureRuntime):
    def __init__(self) -> None:
        super().__init__()
        self.event_cursors: list[str | int | None] = []
        self.cancel_calls = 0

    def capture_events(
        self,
        capture_id: str,
        *,
        last_event_id: str | int | None = None,
        on_activity=None,
    ):
        self.event_cursors.append(last_event_id)
        if on_activity is not None:
            on_activity()
        yield CaptureEventV2.model_validate(
            {
                "protocolVersion": "2",
                "eventId": f"{capture_id}/2",
                "sequence": 2,
                "captureId": capture_id,
                "kind": "pdf",
                "eventType": "checkpoint",
                "stage": "awaiting_structuring",
                "progress": 0.7,
                "partialRevision": 1,
                "segments": [],
                "createdAt": NOW.isoformat(),
            }
        )

    def cancel_capture(self, capture_id: str) -> CaptureOperationV2:
        self.cancel_calls += 1
        return super().cancel_capture(capture_id)


class DurableTerminalReplayCaptureRuntime(DeterministicCaptureRuntime):
    def __init__(self) -> None:
        super().__init__()
        self.event_cursors: list[str | int | None] = []
        self.cancel_calls = 0

    def _operation(self, *, status: str) -> CaptureOperationV2:
        operation = super()._operation(status=status)
        return CaptureOperationV2.model_validate(
            {
                **operation.model_dump(mode="json", by_alias=True),
                "lastEventSequence": 6 if status == "completed" else 5,
            }
        )

    def capture_events(
        self,
        capture_id: str,
        *,
        last_event_id: str | int | None = None,
        on_activity=None,
    ):
        self.event_cursors.append(last_event_id)
        if capture_id in self.deleted:
            raise CaptureRuntimeError(
                status_code=404,
                code="capture_not_found",
                message="Streaming capture was not found.",
            )
        if on_activity is not None:
            on_activity()
        sequence = 6 if self.result is not None else 5
        cursor = -1 if last_event_id is None else int(last_event_id)
        if cursor >= sequence:
            return
        event_type = "completed" if self.result is not None else "checkpoint"
        yield CaptureEventV2.model_validate(
            {
                "protocolVersion": "2",
                "eventId": f"{capture_id}/{sequence}",
                "sequence": sequence,
                "captureId": capture_id,
                "kind": "pdf",
                "eventType": event_type,
                "stage": event_type if event_type == "completed" else "awaiting_structuring",
                "progress": 1 if event_type == "completed" else 0.7,
                "partialRevision": 1,
                "segments": [],
                "createdAt": NOW.isoformat(),
            }
        )

    def get_result(self, capture_id: str) -> CaptureStreamingResult:
        if capture_id in self.deleted:
            raise CaptureRuntimeError(
                status_code=404,
                code="capture_not_found",
                message="Streaming capture was not found.",
            )
        return super().get_result(capture_id)

    def cancel_capture(self, capture_id: str) -> CaptureOperationV2:
        self.cancel_calls += 1
        return super().cancel_capture(capture_id)


class CommitRaceEventCaptureRuntime(DeterministicCaptureRuntime):
    def __init__(self) -> None:
        super().__init__()
        self.terminal_event_offered = Event()
        self.event_cursors: list[str | int | None] = []

    def _operation(self, *, status: str) -> CaptureOperationV2:
        operation = super()._operation(status=status)
        return CaptureOperationV2.model_validate(
            {
                **operation.model_dump(mode="json", by_alias=True),
                "lastEventSequence": 2 if status == "completed" else 1,
            }
        )

    def capture_events(
        self,
        capture_id: str,
        *,
        last_event_id: str | int | None = None,
        on_activity=None,
    ):
        self.event_cursors.append(last_event_id)
        if self.result is None:
            return
        if on_activity is not None:
            on_activity()
        cursor = -1 if last_event_id is None else int(last_event_id)
        if cursor >= 2:
            return
        self.terminal_event_offered.set()
        yield CaptureEventV2.model_validate(
            {
                "protocolVersion": "2",
                "eventId": f"{capture_id}/2",
                "sequence": 2,
                "captureId": capture_id,
                "kind": "pdf",
                "eventType": "completed",
                "stage": "completed",
                "progress": 1,
                "partialRevision": 1,
                "segments": [],
                "createdAt": NOW.isoformat(),
            }
        )


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
    assert len(runtime.created_request_ids) == 1
    assert runtime.created_request_ids[0]
    assert len(runtime.commit_idempotency_keys) == 1


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


def test_review_image_preserves_canonical_jpeg_source_identity(tmp_path: Path) -> None:
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
        source = minimal_image("JPEG")

        created = client.post(
            f"/projects/{project_id}/capture-workbench/captures",
            headers=headers,
            files={"file": ("capture.pdf", source, "image/jpeg")},
        )
        capture_id = created.json()["captureId"]
        pending = _wait_for_capture_status(
            client,
            project_id=project_id,
            capture_id=capture_id,
            headers=headers,
            status_value="awaiting_structuring",
        )
        partial = client.get(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/partial",
            headers=headers,
        )

        assert created.status_code == 202
        assert created.json()["kind"] == "image"
        assert created.json()["source"]["mediaType"] == "image/jpeg"
        assert pending.json()["kind"] == "image"
        assert pending.json()["source"]["mediaType"] == "image/jpeg"
        assert partial.status_code == 200
        assert partial.json()["source"]["mediaType"] == "image/jpeg"


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


def test_review_result_fails_closed_when_runtime_replay_violates_contract(
    tmp_path: Path,
) -> None:
    runtime = InvalidResultReplayCaptureRuntime()
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
        created = client.post(
            f"/projects/{project_id}/capture-workbench/captures",
            headers=headers,
            files={"file": ("review.pdf", minimal_pdf("Review result."), "application/pdf")},
        )
        capture_id = created.json()["captureId"]
        _wait_for_capture_status(
            client,
            project_id=project_id,
            capture_id=capture_id,
            headers=headers,
            status_value="awaiting_structuring",
        )
        structured = client.post(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/structure",
            headers=headers,
            json={
                "clientRequestId": "invalid-result-structure",
                "review": {"reviewVersion": 1, "edits": []},
            },
        )
        committed = client.post(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/structure/commit",
            headers=headers,
            json={
                "clientRequestId": "invalid-result-commit",
                "candidate": structured.json(),
            },
        )
        assert committed.status_code == 202
        _wait_for_capture_status(
            client,
            project_id=project_id,
            capture_id=capture_id,
            headers=headers,
            status_value="completed",
        )

        result = client.get(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/result",
            headers=headers,
        )

        assert result.status_code == 502
        assert result.json() == {
            "code": "capture_runtime_protocol_error",
            "message": "Capture Runtime result violated the v2 contract.",
        }
        assert runtime.result_reads == 2


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

    assert runtime.created_request_ids
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

    assert runtime.created_request_ids
    assert runtime.requirement_reads == 1


def test_pending_host_snapshot_does_not_expose_runtime_terminal_state(
    tmp_path: Path,
) -> None:
    runtime = PendingTerminalRaceCaptureRuntime()
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
        created = client.post(
            f"/projects/{project_id}/capture-workbench/captures",
            headers=headers,
            files={"file": ("pending-race.pdf", minimal_pdf("Pending race."), "application/pdf")},
        )
        document_id = created.json()["documentId"]
        assert runtime.listener_waiting.wait(timeout=2)
        try:
            snapshot = client.get(
                f"/projects/{project_id}/capture-workbench/captures/{created.json()['captureId']}",
                headers=headers,
            )
            assert snapshot.status_code == 200
            assert snapshot.json()["status"] == "created"
            assert snapshot.json()["ingestionId"] == document_id
        finally:
            runtime.release_terminal_event.set()

        failed = _wait_for_capture_status(
            client,
            project_id=project_id,
            capture_id=created.json()["captureId"],
            headers=headers,
            status_value="failed",
        )
        assert failed.json()["ingestionId"] == document_id


def test_review_capture_pauses_before_persistence_and_applies_confirmed_overlay(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = DeterministicCaptureRuntime()
    publish_started = Event()
    allow_publish = Event()
    publish_capture_document = review_workflow.publish_capture_document

    def blocked_publish_capture_document(*args, **kwargs):
        publish_started.set()
        if not allow_publish.wait(timeout=5):
            raise RuntimeError("test did not release capture publication")
        return publish_capture_document(*args, **kwargs)

    monkeypatch.setattr(
        review_workflow,
        "publish_capture_document",
        blocked_publish_capture_document,
    )
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
        assert capture["protocolVersion"] == "2"
        assert capture["status"] == "created"

        pending_document = client.get(
            f"/projects/{project_id}/documents/{capture['documentId']}",
            headers=headers,
        ).json()
        assert pending_document["status"] == "processing"
        assert pending_document["chunks_count"] == 0

        pending = _wait_for_capture_status(
            client,
            project_id=project_id,
            capture_id=capture_id,
            headers=headers,
            status_value="awaiting_structuring",
        )
        assert pending.status_code == 200
        assert pending.json()["captureId"] == capture_id
        assert pending.json()["status"] == "awaiting_structuring"
        partial = client.get(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/partial",
            headers=headers,
        )
        assert partial.status_code == 200
        assert partial.json()["captureId"] == capture_id
        assert partial.json()["segments"][0]["text"] == "Sidecar extracted source text"
        assert (
            client.get(
                f"/projects/{project_id}/capture-workbench/captures/{capture_id}/result",
                headers=headers,
            ).status_code
            == 409
        )

        invalid_review = client.post(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/structure",
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

        structured = client.post(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/structure",
            headers=headers,
            json={
                "clientRequestId": "review-confirm-1",
                "review": {
                    "reviewVersion": 1,
                    "edits": [{"segmentId": "page-1", "reviewedText": "Corrected OCR text"}],
                },
            },
        )
        assert structured.status_code == 200
        candidate = structured.json()
        assert candidate["rawSegments"][0]["text"] == "Sidecar extracted source text"
        assert candidate["blocks"][0]["targetText"] == "Corrected OCR text"

        committed = client.post(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/structure/commit",
            headers=headers,
            json={
                "clientRequestId": "review-confirm-1",
                "candidate": candidate,
            },
        )
        assert committed.status_code == 202
        assert committed.json()["status"] == "structuring"

        assert publish_started.wait(timeout=2)
        try:
            committing = client.get(
                f"/projects/{project_id}/capture-workbench/captures/{capture_id}",
                headers=headers,
            )
            assert committing.status_code == 200
            assert committing.json()["status"] == "structuring"
        finally:
            allow_publish.set()

        _wait_for_capture_status(
            client,
            project_id=project_id,
            capture_id=capture_id,
            headers=headers,
            status_value="completed",
        )
        result = client.get(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/result",
            headers=headers,
        )
        assert result.status_code == 200
        assert result.json()["raw"]["segments"][0]["text"] == "Sidecar extracted source text"
        assert result.json()["result"]["blocks"][0]["targetText"] == "Corrected OCR text"

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

    assert runtime.deleted == ["capture-pipeline-1"]


def test_host_events_wait_for_durable_commit_before_emitting_terminal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = CommitRaceEventCaptureRuntime()
    publish_started = Event()
    allow_publish = Event()
    response_finished = Event()
    publish_capture_document = review_workflow.publish_capture_document

    def blocked_publish_capture_document(*args, **kwargs):
        publish_started.set()
        if not allow_publish.wait(timeout=5):
            raise RuntimeError("test did not release capture publication")
        return publish_capture_document(*args, **kwargs)

    monkeypatch.setattr(
        review_workflow,
        "publish_capture_document",
        blocked_publish_capture_document,
    )
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
        created = client.post(
            f"/projects/{project_id}/capture-workbench/captures",
            headers=headers,
            files={"file": ("race.pdf", minimal_pdf("Commit race."), "application/pdf")},
        )
        capture_id = created.json()["captureId"]
        document_id = created.json()["documentId"]
        assert created.json()["ingestionId"] == document_id
        pending = _wait_for_capture_status(
            client,
            project_id=project_id,
            capture_id=capture_id,
            headers=headers,
            status_value="awaiting_structuring",
        )
        assert pending.json()["ingestionId"] == document_id
        structured = client.post(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/structure",
            headers=headers,
            json={
                "clientRequestId": "race-structure",
                "review": {"reviewVersion": 1, "edits": []},
            },
        )
        committed = client.post(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/structure/commit",
            headers=headers,
            json={
                "clientRequestId": "race-commit",
                "candidate": structured.json(),
            },
        )
        assert committed.status_code == 202
        assert publish_started.wait(timeout=2)

        events_url = (
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/events"
        )

        def read_events():
            response = client.get(
                events_url,
                headers={**headers, "Last-Event-ID": "1"},
            )
            response_finished.set()
            return response

        with ThreadPoolExecutor(max_workers=1) as executor:
            response_future = executor.submit(read_events)
            assert runtime.terminal_event_offered.wait(timeout=2)
            try:
                during_commit = client.get(
                    f"/projects/{project_id}/capture-workbench/captures/{capture_id}",
                    headers=headers,
                )
                assert during_commit.json()["status"] == "structuring"
                assert during_commit.json()["lastEventSequence"] == 2
                assert during_commit.json()["ingestionId"] == document_id
                assert not response_finished.wait(timeout=1.2)
            finally:
                allow_publish.set()
            response = response_future.result(timeout=5)

        assert response.status_code == 200
        assert ": cert-prep waiting for durable terminal state\n\n" in response.text
        assert response.text.count("event: completed") == 1
        assert "id: 2\nevent: completed" in response.text
        completed = client.get(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}",
            headers=headers,
        )
        assert completed.json()["status"] == "completed"
        assert completed.json()["lastEventSequence"] == 2
        assert completed.json()["ingestionId"] == document_id
        result = client.get(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/result",
            headers=headers,
        )
        assert result.status_code == 200
        assert result.json()["operation"]["ingestionId"] == document_id

    assert runtime.event_cursors == [1]


def test_review_capture_events_proxy_replays_with_host_identity_without_cancel(
    tmp_path: Path,
) -> None:
    runtime = ReplayableEventCaptureRuntime()
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
        created = client.post(
            f"/projects/{project_id}/capture-workbench/captures",
            headers=headers,
            files={
                "file": (
                    "events.pdf",
                    minimal_pdf("Replay this event."),
                    "application/pdf",
                )
            },
        )
        capture_id = created.json()["captureId"]

        with client.stream(
            "GET",
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/events",
            headers={**headers, "Last-Event-ID": "1"},
        ) as response:
            body = response.read().decode()

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        assert body.startswith("id: 2\nevent: checkpoint\ndata: ")
        payload = json.loads(body.split("data: ", 1)[1].strip())
        assert payload["captureId"] == capture_id
        assert payload["eventId"] == f"{capture_id}/2"
        assert runtime.event_cursors == [1]
        assert runtime.cancel_calls == 0


def test_review_capture_events_reject_invalid_cursor_before_streaming(
    tmp_path: Path,
) -> None:
    runtime = ReplayableEventCaptureRuntime()
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
        created = client.post(
            f"/projects/{project_id}/capture-workbench/captures",
            headers=headers,
            files={"file": ("cursor.pdf", minimal_pdf("Validate cursor."), "application/pdf")},
        )
        capture_id = created.json()["captureId"]

        for invalid_cursor in ("not-a-number", "1.0", "+1", "-2"):
            response = client.get(
                f"/projects/{project_id}/capture-workbench/captures/{capture_id}/events",
                headers={**headers, "Last-Event-ID": invalid_cursor},
            )
            assert response.status_code == 422

        assert runtime.event_cursors == []
        assert runtime.cancel_calls == 0


def test_review_capture_events_treat_empty_cursor_as_initial_subscription(
    tmp_path: Path,
) -> None:
    runtime = ReplayableEventCaptureRuntime()
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
        created = client.post(
            f"/projects/{project_id}/capture-workbench/captures",
            headers=headers,
            files={"file": ("cursor.pdf", minimal_pdf("Empty cursor."), "application/pdf")},
        )
        capture_id = created.json()["captureId"]

        response = client.get(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/events",
            headers={**headers, "Last-Event-ID": ""},
        )

        assert response.status_code == 200
        assert response.text.startswith("id: 2\nevent: checkpoint")
        assert runtime.event_cursors == [None]
        assert runtime.cancel_calls == 0


def test_terminal_event_replays_monotonically_after_result_deletes_runtime(
    tmp_path: Path,
) -> None:
    runtime = DurableTerminalReplayCaptureRuntime()
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
        created = client.post(
            f"/projects/{project_id}/capture-workbench/captures",
            headers=headers,
            files={"file": ("terminal.pdf", minimal_pdf("Replay terminal."), "application/pdf")},
        )
        capture_id = created.json()["captureId"]
        _wait_for_capture_status(
            client,
            project_id=project_id,
            capture_id=capture_id,
            headers=headers,
            status_value="awaiting_structuring",
        )

        with client.stream(
            "GET",
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/events",
            headers={**headers, "Last-Event-ID": "4"},
        ) as response:
            assert response.read().decode().startswith("id: 5\nevent: checkpoint")

        structured = client.post(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/structure",
            headers=headers,
            json={
                "clientRequestId": "terminal-structure",
                "review": {"reviewVersion": 1, "edits": []},
            },
        )
        assert structured.status_code == 200
        committed = client.post(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/structure/commit",
            headers=headers,
            json={
                "clientRequestId": "terminal-commit",
                "candidate": structured.json(),
            },
        )
        assert committed.status_code == 202
        _wait_for_capture_status(
            client,
            project_id=project_id,
            capture_id=capture_id,
            headers=headers,
            status_value="completed",
        )
        result = client.get(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/result",
            headers=headers,
        )
        assert result.status_code == 200
        assert result.json()["operation"]["lastEventSequence"] == 6
        assert runtime.deleted == ["capture-pipeline-1"]

        durable_replay = client.get(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/result",
            headers=headers,
        )
        assert durable_replay.status_code == 200
        assert durable_replay.json()["operation"]["lastEventSequence"] == 6
        assert durable_replay.json()["result"]["blocks"][0]["targetText"]

        snapshot = client.get(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}",
            headers=headers,
        )
        assert snapshot.status_code == 200
        assert snapshot.json()["lastEventSequence"] == 6

        with client.stream(
            "GET",
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/events",
            headers={**headers, "Last-Event-ID": "5"},
        ) as response:
            terminal = response.read().decode()
        assert terminal.startswith("id: 6\nevent: completed")

        with client.stream(
            "GET",
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/events",
            headers={**headers, "Last-Event-ID": "6"},
        ) as response:
            assert response.read() == b""

    assert runtime.event_cursors == [4, 5, 6]
    assert runtime.cancel_calls == 0


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
        _wait_for_capture_status(
            client,
            project_id=project_id,
            capture_id=capture_id,
            headers=headers,
            status_value="awaiting_structuring",
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
        _wait_for_capture_status(
            client,
            project_id=project_id,
            capture_id=capture_id,
            headers=headers,
            status_value="awaiting_structuring",
        )
        review = {
            "reviewVersion": 1,
            "edits": [{"segmentId": "page-1", "reviewedText": "Confirmed once"}],
        }
        structured = client.post(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/structure",
            headers=headers,
            json={"clientRequestId": "confirm-once", "review": review},
        )
        assert structured.status_code == 200
        candidate = structured.json()
        first = client.post(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/structure/commit",
            headers=headers,
            json={"clientRequestId": "confirm-once", "candidate": candidate},
        )
        assert first.status_code == 202
        assert runtime.commit_started.wait(timeout=2)

        replay = client.post(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/structure/commit",
            headers=headers,
            json={"clientRequestId": "confirm-once", "candidate": candidate},
        )
        assert replay.status_code == 202
        assert replay.json()["status"] == "structuring"

        divergent_candidate = json.loads(json.dumps(candidate))
        divergent_candidate["blocks"][0]["targetText"] = "Changed replay"
        divergent_candidate["targetText"] = "Changed replay"
        divergent = client.post(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/structure/commit",
            headers=headers,
            json={
                "clientRequestId": "confirm-once",
                "candidate": divergent_candidate,
            },
        )
        assert divergent.status_code == 409

        runtime.release_commit.set()
        completed = _wait_for_capture_status(
            client,
            project_id=project_id,
            capture_id=capture_id,
            headers=headers,
            status_value="completed",
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


def _wait_for_capture_status(
    client: TestClient,
    *,
    project_id: str,
    capture_id: str,
    headers: dict[str, str],
    status_value: str,
) -> object:
    endpoint = f"/projects/{project_id}/capture-workbench/captures/{capture_id}"
    for _ in range(100):
        response = client.get(endpoint, headers=headers)
        if response.status_code == 200 and response.json()["status"] == status_value:
            return response
        time.sleep(0.01)
    raise AssertionError(
        f"Capture did not reach status {status_value!r}; last response={response.text}"
    )
