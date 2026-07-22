from __future__ import annotations

from datetime import UTC, datetime
import hashlib
import json
from pathlib import Path
from uuid import UUID

from fastapi.testclient import TestClient

from conftest import AUTH_TOKEN, minimal_audio, minimal_pdf
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
                "type": "transcript"
                if segment["locator"]["kind"] == "time"
                else "paragraph",
                "sourceSegmentId": segment["segmentId"],
                "locator": segment["locator"],
                "sourceText": segment["text"],
                "targetText": segment["text"],
            }
            for segment in prompt["rawSegments"]
        ]
        return json.dumps({"blocks": blocks})


class DeterministicCaptureRuntime:
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
        assert source_kind is CaptureSourceKind.PDF
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
        raise AssertionError("deterministic job should not require polling")

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
