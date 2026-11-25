from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
import gc
import hashlib
import json
from threading import Event
import time
from pathlib import Path
import weakref
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from conftest import (
    AUTH_TOKEN,
    _test_ocr_projection,
    _test_runtime_ready,
    _test_runtime_requirements,
    minimal_audio,
    minimal_image,
    minimal_pdf,
    TypedPullSessionRuntimeMixin,
)
from cert_prep_backend.bootstrap.app import create_app
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.database import Database
from cert_prep_backend.capture_integration.infrastructure.client import (
    CaptureRuntimeError,
    CaptureRuntimeProtocolError,
    CaptureResult,
    CaptureUpload,
)
from cert_prep_backend.capture_integration.infrastructure import review_workflow
from cert_prep_backend.capture_integration.infrastructure.persistence import (
    publish_capture_document,
)
from cert_prep_backend.bootstrap.capture_links import capture_publication
from cert_prep_backend.source_library.infrastructure import operations
from cert_prep_backend.capture_integration.application.messages import (
    SPEECH_RECOGNITION_UNAVAILABLE_MESSAGE,
    TEXT_RECOGNITION_FAILED_MESSAGE,
    TEXT_RECOGNITION_UNAVAILABLE_MESSAGE,
)
from cert_prep_backend.source_library.domain.document import (
    NO_TEXT_DETECTED_MESSAGE,
    ExtractedPage,
    PageExtraction,
)
from capture_runtime_client import (
    CAPTURE_RUNTIME_VERSION,
    CaptureDocument,
    CaptureEvent,
    CaptureOperation,
    CaptureSourceKind,
    PartialCapture,
    RawCapture,
    RuntimeRequirements,
)
from cert_prep_backend.capture_integration.infrastructure.host_models import RuntimeReady
from cert_prep_backend.capture_integration.api.router import CaptureRuntimeEventRegistry
from document_test_helpers import _create_project
from document_test_llm_fakes import FakeQuestionWriter


NOW = datetime(2026, 7, 20, 5, 0, tzinfo=UTC)


def _public_capture_document(
    *,
    engine: str = "text-recognition",
) -> tuple[CaptureDocument, RawCapture]:
    raw = RawCapture.model_validate(
        {
            "schemaVersion": "2",
            "diagnosticOnly": True,
            "source": {
                "sha256": "a" * 64,
                "fileName": "capture.pdf",
                "mediaType": "application/pdf",
                "bytes": 42,
            },
            "segments": [
                {
                    "segmentId": "page-1",
                    "order": 0,
                    "locator": {"kind": "page", "page": 1},
                    "text": "Runtime OCR text",
                }
            ],
            "sourceText": "Runtime OCR text",
            "extractionEngine": {
                "engine": engine,
                "model": "capture-ocr-v1",
                "digest": "sha256:" + "b" * 64,
                "device": "igpu",
            },
            "warnings": [],
            "createdAt": NOW.isoformat(),
        }
    )
    document = CaptureDocument.model_validate(
        {
            "schemaVersion": "2",
            "source": raw.source.model_dump(mode="json", by_alias=True),
            "rawSegments": raw.segments,
            "blocks": [
                {
                    "blockId": "block-1",
                    "order": 0,
                    "type": "paragraph",
                    "sourceSegmentId": "page-1",
                    "locator": {"kind": "page", "page": 1},
                    "sourceText": "Runtime OCR text",
                    "targetText": "Translated text",
                }
            ],
            "sourceText": "Runtime OCR text",
            "targetText": "Translated text",
            "extractionEngine": {
                "engine": engine,
                "model": "capture-ocr-v1",
                "digest": "sha256:" + "b" * 64,
                "device": "igpu",
            },
            "structuringEngine": {
                "engine": "ollama",
                "model": "cert-prep-qwen",
                "digest": "sha256:" + "c" * 64,
            },
            "warnings": [],
            "createdAt": NOW.isoformat(),
            "completedAt": NOW.isoformat(),
        }
    )
    return document, raw


def _attach_public_capture(
    app,
    client: TestClient,
    tmp_path: Path,
    *,
    engine: str = "text-recognition",
) -> dict[str, object]:
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
    project_id = _create_project(client, headers)
    operation_id = str(uuid4())
    document_id = str(uuid4())
    operations.claim_operation(
        app.state.database,
        project_id=project_id,
        operation_id=operation_id,
    )
    operations.create_and_attach_document(
        app.state.database,
        project_id=project_id,
        operation_id=operation_id,
        document_id=document_id,
        filename="capture.pdf",
        source_kind="pdf",
        sha256="a" * 64,
        language_hint="auto",
        storage_path=str(tmp_path / "capture.pdf"),
        page_count=1,
    )
    document, raw = _public_capture_document(engine=engine)
    return {
        "project_id": project_id,
        "operation_id": operation_id,
        "document_id": document_id,
        "document": document,
        "projection": _test_ocr_projection(raw, "capture-1"),
    }


def _public_capture_counts(
    app,
    *,
    project_id: str,
    document_id: str,
) -> tuple[int, int, str, int]:
    with app.state.database.connect() as connection:
        document = connection.execute(
            "SELECT status, processed_page_count FROM documents WHERE project_id = ? AND id = ?",
            (project_id, document_id),
        ).fetchone()
        assert document is not None
        documents = connection.execute(
            "SELECT COUNT(*) FROM documents WHERE project_id = ?",
            (project_id,),
        ).fetchone()[0]
        chunks = connection.execute(
            "SELECT COUNT(*) FROM document_chunks WHERE project_id = ? AND document_id = ?",
            (project_id, document_id),
        ).fetchone()[0]
    return int(documents), int(chunks), str(document["status"]), int(document["processed_page_count"])


@pytest.mark.parametrize(
    "engine",
    ["direct_pdf", "embedded", "mixed", "windowsml-v2", "direct_pdf-windowsml"],
)
def test_public_capture_publication_rejects_noncanonical_write_provenance(
    tmp_path: Path,
    engine: str,
) -> None:
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake"),
        document_processing_async_jobs=False,
        background_question_jobs=False,
    )
    with TestClient(app) as client:
        fixture = _attach_public_capture(app, client, tmp_path, engine=engine)
        document = fixture["document"]
        projection = fixture["projection"]
        assert isinstance(document, CaptureDocument)
        with pytest.raises(ValueError, match="OCR-only"):
            publish_capture_document(
                runtime_version=CAPTURE_RUNTIME_VERSION,
                project_id=str(fixture["project_id"]),
                document_id=str(fixture["document_id"]),
                operation_id=str(fixture["operation_id"]),
                source_kind="pdf",
                expected_sha256="a" * 64,
                document=document,
                ocr_projection=projection,
                publication=capture_publication(app.state.database),
            )

        assert _public_capture_counts(
            app,
            project_id=str(fixture["project_id"]),
            document_id=str(fixture["document_id"]),
        ) == (1, 0, "processing", 0)


def test_public_capture_publication_maps_exact_producer_engine_to_durable_method(
    tmp_path: Path,
) -> None:
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake"),
        document_processing_async_jobs=False,
        background_question_jobs=False,
    )
    with TestClient(app) as client:
        fixture = _attach_public_capture(app, client, tmp_path)
        document = fixture["document"]
        projection = fixture["projection"]
        assert isinstance(document, CaptureDocument)
        result = publish_capture_document(
            runtime_version=CAPTURE_RUNTIME_VERSION,
            project_id=str(fixture["project_id"]),
            document_id=str(fixture["document_id"]),
            operation_id=str(fixture["operation_id"]),
            source_kind="pdf",
            expected_sha256="a" * 64,
            document=document,
            ocr_projection=projection,
            publication=capture_publication(app.state.database),
        )

        assert result.extraction_method == "text_recognition"
        assert _public_capture_counts(
            app,
            project_id=str(fixture["project_id"]),
            document_id=str(fixture["document_id"]),
        ) == (1, 1, "ready", 1)


@pytest.mark.parametrize("projection_engine", ["windowsml-v2", "direct_pdf"])
def test_public_capture_publication_rejects_projection_engine_mismatch(
    tmp_path: Path,
    projection_engine: str,
) -> None:
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake"),
        document_processing_async_jobs=False,
        background_question_jobs=False,
    )
    with TestClient(app) as client:
        fixture = _attach_public_capture(app, client, tmp_path)
        document = fixture["document"]
        projection = fixture["projection"]
        assert isinstance(document, CaptureDocument)
        document.extraction_engine.model = "embedded-text-model"
        projection.provenance.engine = projection_engine
        for page in projection.pages:
            page.provenance.engine = projection_engine

        with pytest.raises(ValueError, match="provenance"):
            publish_capture_document(
                runtime_version=CAPTURE_RUNTIME_VERSION,
                project_id=str(fixture["project_id"]),
                document_id=str(fixture["document_id"]),
                operation_id=str(fixture["operation_id"]),
                source_kind="pdf",
                expected_sha256="a" * 64,
                document=document,
                ocr_projection=projection,
                publication=capture_publication(app.state.database),
            )

        assert _public_capture_counts(
            app,
            project_id=str(fixture["project_id"]),
            document_id=str(fixture["document_id"]),
        ) == (1, 0, "processing", 0)


def test_public_capture_publication_rejects_page_provenance_mismatch_without_writes(
    tmp_path: Path,
) -> None:
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake"),
        document_processing_async_jobs=False,
        background_question_jobs=False,
    )
    with TestClient(app) as client:
        fixture = _attach_public_capture(app, client, tmp_path)
        document = fixture["document"]
        projection = fixture["projection"]
        assert isinstance(document, CaptureDocument)
        projection.pages[0].provenance.engine = "windowsml-v2"

        with pytest.raises(ValueError, match="provenance"):
            publish_capture_document(
                runtime_version=CAPTURE_RUNTIME_VERSION,
                project_id=str(fixture["project_id"]),
                document_id=str(fixture["document_id"]),
                operation_id=str(fixture["operation_id"]),
                source_kind="pdf",
                expected_sha256="a" * 64,
                document=document,
                ocr_projection=projection,
                publication=capture_publication(app.state.database),
            )

        assert _public_capture_counts(
            app,
            project_id=str(fixture["project_id"]),
            document_id=str(fixture["document_id"]),
        ) == (1, 0, "processing", 0)


def test_public_capture_publication_rejects_unresolved_page_without_writes(
    tmp_path: Path,
) -> None:
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake"),
        document_processing_async_jobs=False,
        background_question_jobs=False,
    )
    with TestClient(app) as client:
        fixture = _attach_public_capture(app, client, tmp_path)
        document = fixture["document"]
        projection = fixture["projection"]
        assert isinstance(document, CaptureDocument)
        projection.pages[0].provenance.status.value = "unavailable"
        projection.pages[0].provenance.reason = "model_unavailable"

        with pytest.raises(ValueError, match="provenance"):
            publish_capture_document(
                runtime_version=CAPTURE_RUNTIME_VERSION,
                project_id=str(fixture["project_id"]),
                document_id=str(fixture["document_id"]),
                operation_id=str(fixture["operation_id"]),
                source_kind="pdf",
                expected_sha256="a" * 64,
                document=document,
                ocr_projection=projection,
                publication=capture_publication(app.state.database),
            )

        assert _public_capture_counts(
            app,
            project_id=str(fixture["project_id"]),
            document_id=str(fixture["document_id"]),
        ) == (1, 0, "processing", 0)


def test_public_capture_publication_uses_projection_validation_for_embedded_model_marker(
    tmp_path: Path,
) -> None:
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake"),
        document_processing_async_jobs=False,
        background_question_jobs=False,
    )
    with TestClient(app) as client:
        fixture = _attach_public_capture(app, client, tmp_path)
        document = fixture["document"]
        projection = fixture["projection"]
        assert isinstance(document, CaptureDocument)
        document.extraction_engine.model = "embedded-text-model"

        result = publish_capture_document(
            runtime_version=CAPTURE_RUNTIME_VERSION,
            project_id=str(fixture["project_id"]),
            document_id=str(fixture["document_id"]),
            operation_id=str(fixture["operation_id"]),
            source_kind="pdf",
            expected_sha256="a" * 64,
            document=document,
            ocr_projection=projection,
            publication=capture_publication(app.state.database),
        )

        assert result.extraction_method == "text_recognition"


def test_legacy_text_layer_rows_remain_read_compatible(tmp_path: Path) -> None:
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake"),
        document_processing_async_jobs=False,
        background_question_jobs=False,
    )
    with TestClient(app) as client:
        headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(
            client,
            headers,
        )
        expected_document_ids: dict[str, str] = {}
        for method in ("text_layer",):
            operation_id = str(uuid4())
            document_id = str(uuid4())
            expected_document_ids[method] = document_id
            operations.claim_operation(
                app.state.database,
                project_id=project_id,
                operation_id=operation_id,
            )
            operations.create_and_attach_document(
                app.state.database,
                project_id=project_id,
                operation_id=operation_id,
                document_id=document_id,
                filename=f"legacy-{method}.pdf",
                source_kind="pdf",
                sha256="a" * 64,
                language_hint="auto",
                storage_path=str(tmp_path / f"legacy-{method}.pdf"),
                page_count=1,
            )
            operations.publish_success(
                app.state.database,
                project_id=project_id,
                operation_id=operation_id,
                document_id=document_id,
                extraction=PageExtraction(
                    page_count=1,
                    pages=(
                        ExtractedPage(
                            page_number=1,
                            text=f"Legacy {method} text",
                            raw_text=f"Legacy {method} text",
                            source_excerpt=f"Legacy {method} text",
                            extraction_method=method,
                            line_start=1,
                            line_end=1,
                            line_count=1,
                        ),
                    ),
                    status="ready",
                    extraction_method=method,
                    ocr_device=None,
                    extraction_warnings=None,
                    processed_page_count=1,
                ),
            )

        documents = client.get(
            f"/projects/{project_id}/documents",
            headers=headers,
        )
        assert documents.status_code == 200
        by_id = {item["id"]: item for item in documents.json()["items"]}
        for method, document_id in expected_document_ids.items():
            assert by_id[document_id]["extraction_method"] == method
            chunks = client.get(
                f"/projects/{project_id}/documents/{document_id}/chunks",
                headers=headers,
            )
            assert chunks.status_code == 200
            assert chunks.json()["items"][0]["extraction_method"] == method


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


class EchoCaptureProvider(FakeQuestionWriter):
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
        assert json_schema["title"] == "CaptureBlockBatch"
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


class DeterministicCaptureRuntime(TypedPullSessionRuntimeMixin):
    expected_source_kind = CaptureSourceKind.PDF

    def __init__(self, *, runtime_version: str = CAPTURE_RUNTIME_VERSION) -> None:
        self.runtime_version = runtime_version
        self.raw: RawCapture | None = None
        self.result: CaptureDocument | None = None
        self.deleted: list[str] = []
        self.created_request_ids: list[str] = []

    def handshake(self) -> RuntimeReady:
        return _test_runtime_ready().model_copy(
            update={"runtime_version": self.runtime_version}
        )

    def get_requirements(self) -> RuntimeRequirements:
        return _test_runtime_requirements("ready")

    def start_capture(
        self,
        upload: CaptureUpload,
        *,
        source_kind: CaptureSourceKind,
        client_request_id: str,
        target_language: str | None = None,
    ) -> CaptureOperation:
        assert source_kind is self.expected_source_kind
        assert target_language is None
        assert isinstance(upload.content, bytes)
        self.created_request_ids.append(client_request_id)
        self.raw = RawCapture.model_validate(
            {
                "schemaVersion": "2",
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
                    "engine": "text-recognition",
                    "model": "capture-ocr-v1",
                    "digest": f"sha256:{'b' * 64}",
                    "device": "igpu",
                },
                "warnings": [],
                "createdAt": NOW.isoformat(),
            }
        )
        return self._operation(status="awaiting_structuring")

    def get_partial(self, capture_id: str) -> PartialCapture:
        assert self.raw is not None
        return PartialCapture.model_validate(
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

    def get_raw(self, _capture_id: str) -> RawCapture:
        assert self.raw is not None
        return self.raw

    def get_result(self, _capture_id: str) -> CaptureResult:
        assert self.raw is not None
        assert self.result is not None
        return CaptureResult(
            operation=self._operation(status="completed"),
            raw=self.raw,
            result=self.result,
        )

    def get_capture(self, _capture_id: str) -> CaptureOperation:
        return self._operation(
            status="completed" if self.result is not None else "awaiting_structuring"
        )

    def report_structuring_failure(self, *_args, **_kwargs):
        raise AssertionError("host provider should succeed")

    def cancel_capture(self, *_args, **_kwargs):
        raise AssertionError("capture should not be cancelled")

    def delete_capture(self, capture_id: str) -> None:
        self.deleted.append(capture_id)

    def _operation(self, *, status: str) -> CaptureOperation:
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
        return CaptureOperation.model_validate(
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


class UnavailablePdfOcrRuntime(DeterministicCaptureRuntime):
    def __init__(self) -> None:
        super().__init__()
        self.requirement_reads = 0

    def get_requirements(self) -> RuntimeRequirements:
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
    ) -> CaptureOperation:
        raise AssertionError("PDF capture must not dispatch without ready OCR")


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
    ) -> CaptureOperation:
        admitted = super().start_capture(
            upload,
            source_kind=source_kind,
            client_request_id=client_request_id,
            target_language=target_language,
        )
        return CaptureOperation.model_validate(
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
        yield CaptureEvent.model_validate(
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

    def get_capture(self, _capture_id: str) -> CaptureOperation:
        return self._operation(status="failed")


class BlockingDeterministicCaptureRuntime(DeterministicCaptureRuntime):
    def __init__(self) -> None:
        super().__init__()
        self.commit_started = Event()
        self.release_commit = Event()
        self.result_reads = 0

    def get_result(self, capture_id: str) -> CaptureResult:
        self.result_reads += 1
        if self.result_reads > 1:
            self.commit_started.set()
        if self.result_reads > 1 and not self.release_commit.wait(timeout=5):
            raise AssertionError("blocking capture runtime was not released")
        return super().get_result(capture_id)


class DeterministicImageCaptureRuntime(DeterministicCaptureRuntime):
    expected_source_kind = CaptureSourceKind.IMAGE


class InvalidResultReplayCaptureRuntime(DeterministicCaptureRuntime):
    def __init__(self) -> None:
        super().__init__()
        self.result_reads = 0

    def get_result(self, capture_id: str) -> CaptureResult:
        self.result_reads += 1
        if self.result_reads > 1:
            raise CaptureRuntimeProtocolError(
                "Capture Runtime returned a mismatched result source"
            )
        return super().get_result(capture_id)


class DeterministicAudioCaptureRuntime(DeterministicCaptureRuntime):
    expected_source_kind = CaptureSourceKind.RECORDING

    def __init__(self) -> None:
        super().__init__()
        self.started_source_kinds: list[CaptureSourceKind] = []
        self.started_media_types: list[str] = []
        self.result_kinds: set[str] = set()

    def _operation(self, *, status: str) -> CaptureOperation:
        operation = super()._operation(status=status)
        self.result_kinds.add(operation.kind.value)
        return operation

    def start_capture(
        self,
        upload: CaptureUpload,
        *,
        source_kind: CaptureSourceKind,
        client_request_id: str,
        target_language: str | None = None,
    ) -> CaptureOperation:
        assert source_kind is CaptureSourceKind.RECORDING
        assert target_language == "zh-Hant"
        self.started_source_kinds.append(source_kind)
        self.started_media_types.append(upload.media_type)
        assert isinstance(upload.content, bytes)
        self.created_request_ids.append(client_request_id)
        self.raw = RawCapture.model_validate(
            {
                "schemaVersion": "2",
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
                    "engine": "speech-recognition",
                    "model": "tea-asr-1.1-mini",
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
        super().__init__()
        self.create_attempts = 0
        self.requirement_reads = 0

    def handshake(self) -> RuntimeReady:
        # Like Capture 0.11.0 without an installed OCR worker: readiness carries
        # no OCR compute preflight.
        return super().handshake().model_copy(update={"ocr_compute": None})

    def get_requirements(self) -> RuntimeRequirements:
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

    def start_capture(self, *args, **kwargs) -> CaptureOperation:
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
        yield CaptureEvent.model_validate(
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

    def cancel_capture(self, capture_id: str) -> CaptureOperation:
        self.cancel_calls += 1
        return super().cancel_capture(capture_id)


class DurableTerminalReplayCaptureRuntime(DeterministicCaptureRuntime):
    def __init__(self) -> None:
        super().__init__()
        self.event_cursors: list[str | int | None] = []
        self.cancel_calls = 0

    def _operation(self, *, status: str) -> CaptureOperation:
        operation = super()._operation(status=status)
        return CaptureOperation.model_validate(
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
        yield CaptureEvent.model_validate(
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

    def get_result(self, capture_id: str) -> CaptureResult:
        if capture_id in self.deleted:
            raise CaptureRuntimeError(
                status_code=404,
                code="capture_not_found",
                message="Streaming capture was not found.",
            )
        return super().get_result(capture_id)

    def cancel_capture(self, capture_id: str) -> CaptureOperation:
        self.cancel_calls += 1
        return super().cancel_capture(capture_id)


class CommitRaceEventCaptureRuntime(DeterministicCaptureRuntime):
    def __init__(self) -> None:
        super().__init__()
        self.terminal_event_offered = Event()
        self.event_cursors: list[str | int | None] = []

    def start_capture(self, upload: CaptureUpload, **kwargs) -> CaptureOperation:
        operation = super().start_capture(upload, **kwargs)
        assert self.raw is not None
        # Fields whose wire names differ from their Python names, so the stored provenance
        # must keep Capture's camelCase form to be read back unchanged.
        engine = self.raw.extraction_engine.model_dump(mode="json", by_alias=True)
        engine.update(
            {"deviceName": "Integrated GPU", "elapsedMs": 1200, "stageMs": {"recognize": 900}}
        )
        self.raw = RawCapture.model_validate(
            {**self.raw.model_dump(mode="json", by_alias=True), "extractionEngine": engine}
        )
        return operation

    def _operation(self, *, status: str) -> CaptureOperation:
        operation = super()._operation(status=status)
        return CaptureOperation.model_validate(
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
        yield CaptureEvent.model_validate(
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
            background_question_jobs=False,
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
        assert document["extraction_method"] == "text_recognition"
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
    assert len(runtime._pull_idempotency_keys) == 1


def test_image_upload_uses_the_same_capture_runtime_host_path(tmp_path: Path) -> None:
    runtime = DeterministicImageCaptureRuntime()
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    with TestClient(
        create_app(
            settings=settings,
            llm_provider=EchoCaptureProvider(),
            capture_runtime_client=runtime,
            document_processing_async_jobs=False,
            background_question_jobs=False,
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
        assert document["source_kind"] == "image"
        assert document["extraction_method"] == "text_recognition"
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
            background_question_jobs=False,
        )
    ) as client:
        headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, headers)
        source = minimal_image("JPEG")

        created = client.post(
            f"/projects/{project_id}/capture-reviews",
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
            f"/projects/{project_id}/capture-reviews/{capture_id}/partial",
            headers=headers,
        )

        assert created.status_code == 202
        assert created.json()["kind"] == "image"
        assert created.json()["source"]["mediaType"] == "image/jpeg"
        assert pending.json()["kind"] == "image"
        assert pending.json()["source"]["mediaType"] == "image/jpeg"
        assert partial.status_code == 200
        assert partial.json()["source"]["mediaType"] == "image/jpeg"


@pytest.mark.parametrize(
    ("suffix", "media_type"),
    [(".wav", "audio/wav"), (".mp3", "audio/mpeg")],
)
def test_audio_upload_uses_capture_time_provenance_without_cert_whisper(
    tmp_path: Path,
    suffix: str,
    media_type: str,
) -> None:
    runtime = DeterministicAudioCaptureRuntime()
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    with TestClient(
        create_app(
            settings=settings,
            llm_provider=EchoCaptureProvider(),
            capture_runtime_client=runtime,
            document_processing_async_jobs=False,
            background_question_jobs=False,
        )
    ) as client:
        headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, headers)
        source = minimal_audio(suffix)

        response = client.post(
            f"/projects/{project_id}/documents",
            headers=headers,
            data={"language_hint": "ja"},
            files={"file": (f"capture{suffix}", source, media_type)},
        )

        assert response.status_code == 201
        document = response.json()
        assert document["status"] == "ready"
        assert document["source_kind"] == "recording"
        assert document["transcription_status"] == "succeeded"
        assert document["translation_status"] == "succeeded"
        assert document["effective_transcription_model"] == "tea-asr-1.1-mini"
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
        # Cert stores the source as "recording" and Capture receives and answers a
        # "recording" capture: the kind maps one to one at the boundary.
        assert runtime.started_source_kinds == [CaptureSourceKind.RECORDING]
        assert runtime.started_media_types == [media_type]
        assert runtime.result_kinds == {"recording"}
        persisted = client.get(
            f"/projects/{project_id}/documents/{document['id']}",
            headers=headers,
        ).json()
        assert persisted["source_kind"] == "recording"

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
            background_question_jobs=False,
        )
    ) as client:
        headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, headers)
        created = client.post(
            f"/projects/{project_id}/capture-reviews",
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
            f"/projects/{project_id}/capture-reviews/{capture_id}/structure",
            headers=headers,
            json={
                "clientRequestId": "invalid-result-structure",
                "review": {"reviewVersion": 2, "edits": []},
            },
        )
        committed = client.post(
            f"/projects/{project_id}/capture-reviews/{capture_id}/structure/commit",
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
            status_value="failed",
        )

        result = client.get(
            f"/projects/{project_id}/capture-reviews/{capture_id}/result",
            headers=headers,
        )

        assert result.status_code == 409
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
            "capture.pdf",
            "application/pdf",
            "extraction_failed",
            "This PDF requires text recognition, which is unavailable in the installed Capture Runtime.",
        ),
        (
            "capture.png",
            "image/png",
            "extraction_failed",
            TEXT_RECOGNITION_UNAVAILABLE_MESSAGE,
        ),
        (
            "capture.wav",
            "audio/wav",
            "transcription_failed",
            SPEECH_RECOGNITION_UNAVAILABLE_MESSAGE,
        ),
    ],
)
def test_core_only_ocr_and_audio_sources_fail_before_sidecar_dispatch(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    filename: str,
    media_type: str,
    expected_document_status: str,
    expected_message: str,
) -> None:
    caplog.set_level("WARNING")
    runtime = CoreOnlyCaptureRuntime()
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    operation_id = f"core-only-{filename.rsplit('.', 1)[-1]}"
    if filename.endswith(".wav"):
        source = minimal_audio(".wav")
    elif filename.endswith(".pdf"):
        source = minimal_pdf("OCR is required for every PDF page.")
    else:
        source = minimal_image()
    with TestClient(
        create_app(
            settings=settings,
            llm_provider=EchoCaptureProvider(),
            capture_runtime_client=runtime,
            document_processing_async_jobs=False,
            background_question_jobs=False,
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
            "code": "capture_requirement_unavailable",
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
        assert documents[0]["failure_message"] == expected_message
        assert documents[0]["extraction_warnings"] is None

    assert runtime.requirement_reads == 1
    assert runtime.create_attempts == 0
    assert runtime.deleted == []
    # The runtime's requirement detail is logged once, in the rendered warning, and stored nowhere.
    [warning] = [
        record.getMessage()
        for record in caplog.records
        if record.levelname == "WARNING" and _REQUIREMENT_DETAIL in record.getMessage()
    ]
    assert warning.startswith("Capture Runtime requirement ")
    assert caplog.text.count(_REQUIREMENT_DETAIL) == 1



_REQUIREMENT_DETAIL = "No downloadable model is published for this runtime release."

_RUNTIME_ONLY_TEXT = "runtime-only detail 7f3a: worker trace at C:/runtime/cache"


class FailingCaptureRuntime(DeterministicCaptureRuntime):
    """A capture the runtime fails at once, with its own failure code and message."""

    def __init__(self, code: str) -> None:
        super().__init__()
        self.code = code

    def start_capture(self, upload, *, source_kind, client_request_id, target_language=None):
        super().start_capture(
            upload,
            source_kind=source_kind,
            client_request_id=client_request_id,
            target_language=target_language,
        )
        operation = self._operation(status="failed")
        return CaptureOperation.model_validate(
            {
                **operation.model_dump(mode="json", by_alias=True),
                "error": {
                    "code": self.code,
                    "message": _RUNTIME_ONLY_TEXT,
                    "stage": "extraction",
                    "retryable": False,
                },
            }
        )


@pytest.mark.parametrize(
    ("code", "expected_document_status", "expected_message"),
    [
        ("ocr_page_failed", "extraction_failed", TEXT_RECOGNITION_FAILED_MESSAGE),
        ("no_text_detected", "no_text_detected", NO_TEXT_DETECTED_MESSAGE),
    ],
)
def test_a_failed_capture_stores_and_shows_cert_text_and_logs_the_runtime_text(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    code: str,
    expected_document_status: str,
    expected_message: str,
) -> None:
    runtime = FailingCaptureRuntime(code)
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    operation_id = f"runtime-failure-{code}"
    caplog.set_level("WARNING")
    # The default upload: the document is accepted and extracted in the background.
    with TestClient(
        create_app(
            settings=settings,
            llm_provider=EchoCaptureProvider(),
            capture_runtime_client=runtime,
            background_question_jobs=False,
        )
    ) as client:
        auth = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, auth)
        response = client.post(
            f"/projects/{project_id}/documents",
            headers={**auth, "X-Cert-Prep-Operation-Id": operation_id},
            files={"file": ("scan.pdf", minimal_pdf("Scanned page."), "application/pdf")},
        )
        assert response.status_code == 201
        accepted = response.json()
        # The worker may finish before the response is built; either way the response is the
        # document, never the runtime's text.
        assert accepted["filename"] == "scan.pdf"
        assert (accepted["status"], accepted["failure_message"]) in {
            ("processing", None),
            (expected_document_status, expected_message),
        }
        operation = None
        for _ in range(200):
            operation = client.get(
                f"/projects/{project_id}/document-operations/{operation_id}", headers=auth
            )
            if operation.json()["status"] == "failed":
                break
            time.sleep(0.01)
        assert operation is not None
        documents = client.get(f"/projects/{project_id}/documents", headers=auth)
        with client.app.state.database.connect() as connection:
            stored = [
                str(value)
                for row in connection.execute(
                    "SELECT failure_message, extraction_warnings FROM documents"
                    " UNION ALL SELECT error, NULL FROM document_operations"
                )
                for value in tuple(row)
                if value is not None
            ]

    assert operation.json()["status"] == "failed"
    assert operation.json()["error"] == expected_message
    [document] = documents.json()["items"]
    assert document["id"] == accepted["id"]
    assert document["status"] == expected_document_status
    assert document["failure_message"] == expected_message
    for body in (response.text, operation.text, documents.text, *stored):
        assert _RUNTIME_ONLY_TEXT not in body
    # The runtime's text is a diagnostic: one warning names it with the Capture code, and no
    # logged traceback carries it as the cause of Cert's error.
    warnings = [
        record.getMessage()
        for record in caplog.records
        if record.levelname == "WARNING" and _RUNTIME_ONLY_TEXT in record.getMessage()
    ]
    assert len(warnings) == 1
    assert f"code {code}" in warnings[0]
    assert caplog.text.count(_RUNTIME_ONLY_TEXT) == 1



class CompletedBeforeStructuringRuntime(DeterministicCaptureRuntime):
    """Capture reports completed before structuring, optionally with an error attached; neither
    is a failure Capture reported for this run."""

    def __init__(self, *, error: dict[str, object] | None = None) -> None:
        super().__init__()
        self.error = error

    def start_capture(self, upload, *, source_kind, client_request_id, target_language=None):
        super().start_capture(
            upload,
            source_kind=source_kind,
            client_request_id=client_request_id,
            target_language=target_language,
        )
        operation = self._operation(status="completed")
        return CaptureOperation.model_validate(
            {
                **operation.model_dump(mode="json", by_alias=True),
                "lastEventSequence": 7,
                "error": self.error,
            }
        )


_ATTACHED_ERROR = {
    "code": "ocr_page_failed",
    "message": "runtime-only note on a completed capture",
    "stage": "extraction",
    "retryable": False,
}


def _start_review_capture_until_failed(app, operation_id: str) -> tuple[str, int]:
    with TestClient(app) as client:
        auth = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, auth)
        response = client.post(
            f"/projects/{project_id}/capture-reviews",
            headers={**auth, "X-Cert-Prep-Operation-Id": operation_id},
            files={"file": ("scanned.pdf", minimal_pdf("Scanned source."), "application/pdf")},
        )
        assert response.status_code == 202
        row = None
        for _ in range(200):
            with app.state.database.connect() as connection:
                row = connection.execute(
                    """SELECT operation.status, operation.error, session.last_event_sequence,
                              session.status
                       FROM document_operations AS operation
                       JOIN capture_review_sessions AS session
                           ON session.operation_id = operation.id
                       WHERE operation.id = ?""",
                    (operation_id,),
                ).fetchone()
            # The operation fails first (its error is the stored cause the review's
            # terminal event reports), then the review session records its terminal.
            if row is not None and row[0] == "failed" and row[3] == "failed":
                break
            time.sleep(0.01)
    assert row is not None and row[0] == "failed" and row[3] == "failed"
    return str(row[1]), int(row[2])


@pytest.mark.parametrize("attached_error", [None, _ATTACHED_ERROR])
def test_a_review_start_without_a_capture_code_keeps_the_generic_message(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, attached_error: dict[str, object] | None
) -> None:
    caplog.set_level("WARNING")
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake"),
        llm_provider=EchoCaptureProvider(),
        capture_runtime_client=CompletedBeforeStructuringRuntime(error=attached_error),
        document_processing_async_jobs=False,
        background_question_jobs=False,
    )

    error, last_event_sequence = _start_review_capture_until_failed(app, "review-no-code")

    assert error == "Capture Runtime extraction failed."
    assert last_event_sequence == 7
    [warning] = [
        record.getMessage()
        for record in caplog.records
        if record.getMessage().startswith("Capture Runtime extraction failed for operation")
    ]
    assert "code None" in warning



def test_a_direct_upload_completed_before_structuring_keeps_the_source_kind_message(
    tmp_path: Path,
) -> None:
    # The generic message belongs to the review path; a direct upload still says which
    # recognition could not read its source.
    with TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake"),
            llm_provider=EchoCaptureProvider(),
            capture_runtime_client=CompletedBeforeStructuringRuntime(),
            document_processing_async_jobs=False,
            background_question_jobs=False,
        ),
        raise_server_exceptions=False,
    ) as client:
        auth = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, auth)
        client.post(
            f"/projects/{project_id}/documents",
            headers={**auth, "X-Cert-Prep-Operation-Id": "direct-completed"},
            files={"file": ("scan.pdf", minimal_pdf("Scanned page."), "application/pdf")},
        )
        operation = client.get(
            f"/projects/{project_id}/document-operations/direct-completed", headers=auth
        ).json()
        [document] = client.get(f"/projects/{project_id}/documents", headers=auth).json()[
            "items"
        ]

    assert operation["status"] == "failed"
    assert operation["error"] == TEXT_RECOGNITION_FAILED_MESSAGE
    assert document["failure_message"] == TEXT_RECOGNITION_FAILED_MESSAGE

def test_a_failed_review_start_stores_cert_text_and_logs_the_runtime_text_once(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level("WARNING")
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake"),
        llm_provider=EchoCaptureProvider(),
        capture_runtime_client=FailingCaptureRuntime("ocr_page_failed"),
        document_processing_async_jobs=False,
        background_question_jobs=False,
    )

    error, _sequence = _start_review_capture_until_failed(app, "review-runtime-text")

    assert error == TEXT_RECOGNITION_FAILED_MESSAGE
    [warning] = [
        record.getMessage()
        for record in caplog.records
        if record.levelname == "WARNING" and _RUNTIME_ONLY_TEXT in record.getMessage()
    ]
    assert "code ocr_page_failed" in warning
    assert caplog.text.count(_RUNTIME_ONLY_TEXT) == 1

def test_a_synchronous_upload_without_text_returns_its_document(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    with TestClient(
        create_app(
            settings=settings,
            llm_provider=EchoCaptureProvider(),
            capture_runtime_client=FailingCaptureRuntime("no_text_detected"),
            document_processing_async_jobs=False,
            background_question_jobs=False,
        )
    ) as client:
        auth = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, auth)
        response = client.post(
            f"/projects/{project_id}/documents",
            headers={**auth, "X-Cert-Prep-Operation-Id": "sync-no-text"},
            files={"file": ("scan.pdf", minimal_pdf("Scanned page."), "application/pdf")},
        )
        operation = client.get(
            f"/projects/{project_id}/document-operations/sync-no-text", headers=auth
        ).json()

    assert response.status_code == 201
    document = response.json()
    assert document["status"] == "no_text_detected"
    assert document["failure_message"] == NO_TEXT_DETECTED_MESSAGE
    assert operation["status"] == "failed"
    assert operation["document_id"] == document["id"]


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
            background_question_jobs=False,
        )
    ) as client:
        headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, headers)
        created = client.post(
            f"/projects/{project_id}/capture-reviews",
            headers=headers,
            files={"file": ("pending-race.pdf", minimal_pdf("Pending race."), "application/pdf")},
        )
        assert created.json()["documentId"] != created.json()["captureId"]
        assert runtime.listener_waiting.wait(timeout=2)
        try:
            snapshot = client.get(
                f"/projects/{project_id}/capture-reviews/{created.json()['captureId']}",
                headers=headers,
            )
            assert snapshot.status_code == 200
            assert snapshot.json()["status"] == "waiting_input"
            assert snapshot.json()["ingestionId"] == "ingestion-pipeline-1"
        finally:
            runtime.release_terminal_event.set()

        failed = _wait_for_capture_status(
            client,
            project_id=project_id,
            capture_id=created.json()["captureId"],
            headers=headers,
            status_value="failed",
        )
        assert failed.json()["ingestionId"] == "ingestion-pipeline-1"
        error = failed.json()["error"]
        assert error["code"] == "capture_review_failed"
        assert error["stage"] == "failed"
        assert error["message"] == TEXT_RECOGNITION_FAILED_MESSAGE
        events = client.get(
            f"/projects/{project_id}/capture-reviews/{created.json()['captureId']}/events",
            headers={**headers, "Last-Event-ID": "0"},
        )
        terminal = json.loads(
            next(line[6:] for line in events.text.splitlines() if line.startswith("data: "))
        )
        assert terminal["error"] == error


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
            background_question_jobs=False,
        )
    ) as client:
        headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, headers)
        source = minimal_pdf("Review before save.")

        created = client.post(
            f"/projects/{project_id}/capture-reviews",
            headers=headers,
            files={"file": ("review.pdf", source, "application/pdf")},
        )

        assert created.status_code == 202
        capture = created.json()
        capture_id = capture["captureId"]
        assert capture["protocolVersion"] == "2"
        assert capture["status"] == "waiting_input"

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
            f"/projects/{project_id}/capture-reviews/{capture_id}/partial",
            headers=headers,
        )
        assert partial.status_code == 200
        assert partial.json()["captureId"] == capture_id
        assert partial.json()["segments"][0]["text"] == "Sidecar extracted source text"
        raw = client.get(
            f"/projects/{project_id}/capture-reviews/{capture_id}/raw",
            headers=headers,
        )
        assert raw.status_code == 200
        assert raw.json()["source"]["sha256"] == capture["source"]["sha256"]
        assert raw.json()["segments"][0]["text"] == "Sidecar extracted source text"
        assert (
            client.get(
                f"/projects/{project_id}/capture-reviews/{capture_id}/result",
                headers=headers,
            ).status_code
            == 409
        )

        invalid_review = client.post(
            f"/projects/{project_id}/capture-reviews/{capture_id}/structure",
            headers=headers,
            json={
                "clientRequestId": "review-confirm-invalid",
                "review": {
                    "reviewVersion": 2,
                    "edits": [{"segmentId": "not-a-runtime-segment", "reviewedText": "x"}],
                },
            },
        )
        assert invalid_review.status_code == 422

        structured = client.post(
            f"/projects/{project_id}/capture-reviews/{capture_id}/structure",
            headers=headers,
            json={
                "clientRequestId": "review-confirm-1",
                "review": {
                    "reviewVersion": 2,
                    "edits": [{"segmentId": "page-1", "reviewedText": "Corrected OCR text"}],
                },
            },
        )
        assert structured.status_code == 200
        candidate = structured.json()
        assert candidate["rawSegments"][0]["text"] == "Sidecar extracted source text"
        assert candidate["blocks"][0]["targetText"] == "Corrected OCR text"

        committed = client.post(
            f"/projects/{project_id}/capture-reviews/{capture_id}/structure/commit",
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
                f"/projects/{project_id}/capture-reviews/{capture_id}",
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
            f"/projects/{project_id}/capture-reviews/{capture_id}/result",
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
            f"/projects/{project_id}/capture-reviews/{capture_id}/cancel",
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
            background_question_jobs=False,
        )
    ) as client:
        headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, headers)
        created = client.post(
            f"/projects/{project_id}/capture-reviews",
            headers=headers,
            files={"file": ("race.pdf", minimal_pdf("Commit race."), "application/pdf")},
        )
        capture_id = created.json()["captureId"]
        document_id = created.json()["documentId"]
        assert capture_id != document_id
        assert created.json()["ingestionId"] == capture_id
        pending = _wait_for_capture_status(
            client,
            project_id=project_id,
            capture_id=capture_id,
            headers=headers,
            status_value="awaiting_structuring",
        )
        assert pending.json()["ingestionId"] == "ingestion-pipeline-1"
        structured = client.post(
            f"/projects/{project_id}/capture-reviews/{capture_id}/structure",
            headers=headers,
            json={
                "clientRequestId": "race-structure",
                "review": {"reviewVersion": 2, "edits": []},
            },
        )
        assert structured.status_code == 200, structured.text
        committed = client.post(
            f"/projects/{project_id}/capture-reviews/{capture_id}/structure/commit",
            headers=headers,
            json={
                "clientRequestId": "race-commit",
                "candidate": structured.json(),
            },
        )
        assert committed.status_code == 202, committed.text
        assert committed.json()["ingestionId"] == "ingestion-pipeline-1"
        assert publish_started.wait(timeout=2)

        events_url = (
            f"/projects/{project_id}/capture-reviews/{capture_id}/events"
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
                deadline = time.monotonic() + 2
                during_commit = None
                while time.monotonic() < deadline:
                    candidate_snapshot = client.get(
                        f"/projects/{project_id}/capture-reviews/{capture_id}",
                        headers=headers,
                    )
                    assert candidate_snapshot.json()["status"] == "structuring"
                    if candidate_snapshot.json()["lastEventSequence"] == 2:
                        during_commit = candidate_snapshot
                        break
                    time.sleep(0.01)
                assert during_commit is not None
                assert during_commit.json()["ingestionId"] == "ingestion-pipeline-1"
                assert not response_finished.wait(timeout=1.2)
            finally:
                allow_publish.set()
            response = response_future.result(timeout=5)

        assert response.status_code == 200
        assert ": cert-prep waiting for durable terminal state\n\n" in response.text
        assert response.text.count("event: completed") == 1
        assert "id: 2\nevent: completed" in response.text
        completed = client.get(
            f"/projects/{project_id}/capture-reviews/{capture_id}",
            headers=headers,
        )
        assert completed.json()["status"] == "completed"
        assert completed.json()["lastEventSequence"] == 2
        assert completed.json()["ingestionId"] == "ingestion-pipeline-1"
        result = client.get(
            f"/projects/{project_id}/capture-reviews/{capture_id}/result",
            headers=headers,
        )
        assert result.status_code == 200
        assert result.json()["operation"]["ingestionId"] == "ingestion-pipeline-1"
        assert result.json()["extractionProvenance"] == {
            "status": "recorded",
            "engine": "text-recognition",
            "model": "capture-ocr-v1",
            "device": "igpu",
            "runtimeVersion": CAPTURE_RUNTIME_VERSION,
        }
        recorded_engine = result.json()["result"]["extractionEngine"]
        assert recorded_engine["deviceName"] == "Integrated GPU"
        assert recorded_engine["elapsedMs"] == 1200
        assert recorded_engine["stageMs"] == {"recognize": 900}
        with Database(settings).connect() as connection:
            stored = connection.execute(
                "SELECT extraction_provenance FROM documents WHERE id = ?", (document_id,)
            ).fetchone()[0]
        assert json.loads(stored)["engine"] == recorded_engine

        with Database(settings).connect() as connection:
            connection.execute(
                "UPDATE documents SET extraction_provenance = NULL WHERE id = ?",
                (document_id,),
            )
        historical = client.get(
            f"/projects/{project_id}/capture-reviews/{capture_id}/result",
            headers=headers,
        )
        assert historical.status_code == 200
        provenance = historical.json()["extractionProvenance"]
        assert provenance["status"] == "reconstructed"
        assert provenance["engine"] == "text-recognition"
        assert provenance["model"] is None
        assert provenance["runtimeVersion"] is None
        assert historical.json()["result"]["extractionEngine"]["model"] == "unknown"

    assert runtime.event_cursors == [1]


def test_capture_awaits_structuring_only_once_its_review_can_be_confirmed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The runtime reaches awaiting_structuring before the host operation enters
    # review. A client that confirms as soon as it sees that status must not get 409.
    runtime = ReplayableEventCaptureRuntime()
    review_entered = Event()
    allow_review = Event()
    events_finished = Event()
    mark_capture_review_pending = operations.mark_capture_review_pending

    def blocked_mark_capture_review_pending(*args, **kwargs):
        review_entered.set()
        if not allow_review.wait(timeout=5):
            raise RuntimeError("test did not release the capture review")
        return mark_capture_review_pending(*args, **kwargs)

    monkeypatch.setattr(
        operations,
        "mark_capture_review_pending",
        blocked_mark_capture_review_pending,
    )
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    with TestClient(
        create_app(
            settings=settings,
            llm_provider=EchoCaptureProvider(),
            capture_runtime_client=runtime,
            document_processing_async_jobs=False,
            background_question_jobs=False,
        )
    ) as client:
        headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, headers)
        created = client.post(
            f"/projects/{project_id}/capture-reviews",
            headers=headers,
            files={"file": ("review.pdf", minimal_pdf("Review gate."), "application/pdf")},
        )
        capture_id = created.json()["captureId"]
        capture_url = f"/projects/{project_id}/capture-reviews/{capture_id}"

        def read_events():
            response = client.get(
                f"{capture_url}/events",
                headers={**headers, "Last-Event-ID": "1"},
            )
            events_finished.set()
            return response

        assert review_entered.wait(timeout=5)
        with ThreadPoolExecutor(max_workers=1) as executor:
            try:
                before_review = client.get(capture_url, headers=headers)
                assert before_review.status_code == 200
                assert before_review.json()["status"] == "extracting"
                events_future = executor.submit(read_events)
                assert not events_finished.wait(timeout=0.5)
            finally:
                allow_review.set()
            events = events_future.result(timeout=5)

        assert events.status_code == 200
        assert '"stage":"awaiting_structuring"' in events.text
        _wait_for_capture_status(
            client,
            project_id=project_id,
            capture_id=capture_id,
            headers=headers,
            status_value="awaiting_structuring",
        )
        structured = client.post(
            f"{capture_url}/structure",
            headers=headers,
            json={
                "clientRequestId": "review-gate-structure",
                "review": {"reviewVersion": 2, "edits": []},
            },
        )
        assert structured.status_code == 200, structured.text
        committed = client.post(
            f"{capture_url}/structure/commit",
            headers=headers,
            json={"clientRequestId": "review-gate-commit", "candidate": structured.json()},
        )
        assert committed.status_code == 202, committed.text
        _wait_for_capture_status(
            client,
            project_id=project_id,
            capture_id=capture_id,
            headers=headers,
            status_value="completed",
        )


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
            background_question_jobs=False,
        )
    ) as client:
        headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, headers)
        created = client.post(
            f"/projects/{project_id}/capture-reviews",
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
            f"/projects/{project_id}/capture-reviews/{capture_id}/events",
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
            background_question_jobs=False,
        )
    ) as client:
        headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, headers)
        created = client.post(
            f"/projects/{project_id}/capture-reviews",
            headers=headers,
            files={"file": ("cursor.pdf", minimal_pdf("Validate cursor."), "application/pdf")},
        )
        capture_id = created.json()["captureId"]

        for invalid_cursor in ("not-a-number", "1.0", "+1", "-2"):
            response = client.get(
                f"/projects/{project_id}/capture-reviews/{capture_id}/events",
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
            background_question_jobs=False,
        )
    ) as client:
        headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, headers)
        created = client.post(
            f"/projects/{project_id}/capture-reviews",
            headers=headers,
            files={"file": ("cursor.pdf", minimal_pdf("Empty cursor."), "application/pdf")},
        )
        capture_id = created.json()["captureId"]

        response = client.get(
            f"/projects/{project_id}/capture-reviews/{capture_id}/events",
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
            background_question_jobs=False,
        )
    ) as client:
        headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, headers)
        created = client.post(
            f"/projects/{project_id}/capture-reviews",
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
            f"/projects/{project_id}/capture-reviews/{capture_id}/events",
            headers={**headers, "Last-Event-ID": "4"},
        ) as response:
            assert response.read().decode().startswith("id: 5\nevent: checkpoint")

        structured = client.post(
            f"/projects/{project_id}/capture-reviews/{capture_id}/structure",
            headers=headers,
            json={
                "clientRequestId": "terminal-structure",
                "review": {"reviewVersion": 2, "edits": []},
            },
        )
        assert structured.status_code == 200
        committed = client.post(
            f"/projects/{project_id}/capture-reviews/{capture_id}/structure/commit",
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
            f"/projects/{project_id}/capture-reviews/{capture_id}/result",
            headers=headers,
        )
        assert result.status_code == 200
        assert result.json()["operation"]["lastEventSequence"] == 6
        assert runtime.deleted == ["capture-pipeline-1"]

        durable_replay = client.get(
            f"/projects/{project_id}/capture-reviews/{capture_id}/result",
            headers=headers,
        )
        assert durable_replay.status_code == 200
        assert durable_replay.json()["operation"]["lastEventSequence"] == 6
        assert durable_replay.json()["result"]["blocks"][0]["targetText"]

        snapshot = client.get(
            f"/projects/{project_id}/capture-reviews/{capture_id}",
            headers=headers,
        )
        assert snapshot.status_code == 200
        assert snapshot.json()["lastEventSequence"] == 6

        with client.stream(
            "GET",
            f"/projects/{project_id}/capture-reviews/{capture_id}/events",
            headers={**headers, "Last-Event-ID": "5"},
        ) as response:
            terminal = response.read().decode()
        assert terminal.startswith("id: 6\nevent: completed")

        with client.stream(
            "GET",
            f"/projects/{project_id}/capture-reviews/{capture_id}/events",
            headers={**headers, "Last-Event-ID": "6"},
        ) as response:
            assert response.read() == b""

    assert runtime.event_cursors == [4, 5, 6]
    assert runtime.cancel_calls == 0


def test_pdf_capture_requirement_unavailable_reports_ocr_required_failure(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level("WARNING")
    runtime = UnavailablePdfOcrRuntime()
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    app = create_app(
        settings=settings,
        llm_provider=EchoCaptureProvider(),
        capture_runtime_client=runtime,
        document_processing_async_jobs=False,
        background_question_jobs=False,
    )
    operation_id = "requirement-unavailable-pdf"
    with TestClient(app) as client:
        headers = {
            "Authorization": f"Bearer {AUTH_TOKEN}",
            "X-Cert-Prep-Operation-Id": operation_id,
        }
        project_id = _create_project(client, {"Authorization": f"Bearer {AUTH_TOKEN}"})
        response = client.post(
            f"/projects/{project_id}/capture-reviews",
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
        "This PDF requires text recognition, which is unavailable in the installed Capture Runtime.",
    )
    assert runtime.requirement_reads == 1
    assert runtime.created_request_ids == []
    [warning] = [
        record.getMessage()
        for record in caplog.records
        if record.levelname == "WARNING" and _REQUIREMENT_DETAIL in record.getMessage()
    ]
    assert warning.startswith("Capture Runtime requirement ")
    assert caplog.text.count(_REQUIREMENT_DETAIL) == 1


def test_expired_review_is_canceled_and_terminal_cancel_is_idempotent(tmp_path: Path) -> None:
    runtime = DeterministicCaptureRuntime()
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    app = create_app(
        settings=settings,
        llm_provider=EchoCaptureProvider(),
        capture_runtime_client=runtime,
        document_processing_async_jobs=False,
        background_question_jobs=False,
    )
    with TestClient(app) as client:
        headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, headers)
        created = client.post(
            f"/projects/{project_id}/capture-reviews",
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
            f"/projects/{project_id}/capture-reviews/{capture_id}",
            headers=headers,
        )
        assert expired.status_code == 200
        assert expired.json()["status"] == "cancelled"

        cancel_again = client.post(
            f"/projects/{project_id}/capture-reviews/{capture_id}/cancel",
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
        background_question_jobs=False,
    )
    with TestClient(app) as client:
        headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, headers)
        source = minimal_pdf("Confirm exactly once.")
        created = client.post(
            f"/projects/{project_id}/capture-reviews",
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
            "reviewVersion": 2,
            "edits": [{"segmentId": "page-1", "reviewedText": "Confirmed once"}],
        }
        structured = client.post(
            f"/projects/{project_id}/capture-reviews/{capture_id}/structure",
            headers=headers,
            json={"clientRequestId": "confirm-once", "review": review},
        )
        assert structured.status_code == 200
        candidate = structured.json()
        first = client.post(
            f"/projects/{project_id}/capture-reviews/{capture_id}/structure/commit",
            headers=headers,
            json={"clientRequestId": "confirm-once", "candidate": candidate},
        )
        assert first.status_code == 202
        assert runtime.commit_started.wait(timeout=2)

        replay = client.post(
            f"/projects/{project_id}/capture-reviews/{capture_id}/structure/commit",
            headers=headers,
            json={"clientRequestId": "confirm-once", "candidate": candidate},
        )
        assert replay.status_code == 202
        assert replay.json()["status"] == "structuring"

        divergent_candidate = json.loads(json.dumps(candidate))
        divergent_candidate["blocks"][0]["targetText"] = "Changed replay"
        divergent_candidate["targetText"] = "Changed replay"
        divergent = client.post(
            f"/projects/{project_id}/capture-reviews/{capture_id}/structure/commit",
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
        max_page_source_upload_bytes=32,
    )
    app = create_app(
        settings=settings,
        llm_provider=EchoCaptureProvider(),
        capture_runtime_client=runtime,
        document_processing_async_jobs=False,
        background_question_jobs=False,
    )
    operation_id = "oversized-capture"
    with TestClient(app) as client:
        headers = {
            "Authorization": f"Bearer {AUTH_TOKEN}",
            "X-Cert-Prep-Operation-Id": operation_id,
        }
        project_id = _create_project(client, {"Authorization": f"Bearer {AUTH_TOKEN}"})
        response = client.post(
            f"/projects/{project_id}/capture-reviews",
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
        background_question_jobs=False,
    )
    with TestClient(app) as client:
        auth_headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id = _create_project(client, auth_headers)

        def upload() -> int:
            response = client.post(
                f"/projects/{project_id}/capture-reviews",
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
    endpoint = f"/projects/{project_id}/capture-reviews/{capture_id}"
    for _ in range(100):
        response = client.get(endpoint, headers=headers)
        if response.status_code == 200 and response.json()["status"] == status_value:
            return response
        time.sleep(0.01)
    raise AssertionError(
        f"Capture did not reach status {status_value!r}; last response={response.text}"
    )
