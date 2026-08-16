from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
import hashlib
from importlib.resources import files
import json
from types import SimpleNamespace
from uuid import UUID

import httpx
from pydantic import ValidationError
import pytest

from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.domains.capture_workbench.client import (
    CaptureRuntimeClient,
    CaptureRuntimeCompatibilityError,
    CaptureRuntimeError,
    CaptureStreamingResult,
    CaptureUpload,
)
from capture_runtime_client import (
    CAPTURE_RUNTIME_VERSION,
    CaptureDocument,
    CaptureOperation,
    CaptureSourceKind,
    PartialCapture,
    RawCapture,
    StructuringBatch,
    StructuringBatchStatus,
    StructuringSession,
    StructuringSessionStatus,
    RuntimeRequirementStatus,
    RuntimeRequirements,
    CaptureStreamingResult as RuntimeStreamingResult,
)
from cert_prep_backend.domains.capture_workbench.host_models import RuntimeReady
from cert_prep_backend.domains.capture_workbench.coordinator import (
    CaptureRunResult,
    CaptureRuntimeCanceledError,
    CaptureRuntimeJobError,
    CaptureRuntimeRequirementUnavailableError,
    CaptureRuntimeStateUnknownError,
    CaptureRuntimeTimeoutError,
    CertPrepCaptureCoordinator,
)
from cert_prep_backend.domains.capture_workbench.mapping import (
    capture_document_to_audio_segments,
    capture_document_to_pdf_extraction,
)
from cert_prep_backend.domains.capture_workbench.structuring import (
    CaptureStructuringCanceledError,
    CaptureStructuringTimeoutError,
    CertPrepCaptureStructuringAdapter,
)
from cert_prep_backend.domains.mock_exams.ollama_transport import OllamaProvider
from cert_prep_backend.domains.mock_exams.provider import LazyDraftGenerationProvider
from llm_test_fakes import RecordingOllamaClient


TOKEN = "capture-sidecar-process-token-that-stays-in-backend"
NOW = datetime(2026, 7, 20, 4, 0, tzinfo=UTC)
IDEMPOTENCY_KEY = UUID("8f86cc35-770e-4df1-a9eb-72f7383d8fba")


def _lost_response(message: str) -> httpx.ReadError:
    return httpx.ReadError(
        message,
        request=httpx.Request("POST", "http://127.0.0.1:43123/v2/captures"),
    )


def _raw_payload() -> dict[str, object]:
    return {
        "schemaVersion": "2",
        "diagnosticOnly": True,
        "source": {
            "sha256": "a" * 64,
            "fileName": "sample.pdf",
            "mediaType": "application/pdf",
            "bytes": 42,
        },
        "segments": [
            {
                "segmentId": "page-1",
                "order": 0,
                "locator": {"kind": "page", "page": 1},
                "text": "Visible source text",
            }
        ],
        "sourceText": "Visible source text",
        "extractionEngine": {
            "engine": "windowsml-ocr",
            "model": "ocr-v1",
            "digest": f"sha256:{'b' * 64}",
            "device": "igpu",
        },
        "warnings": [],
        "createdAt": NOW.isoformat(),
    }


def _raw_with_segments(*, count: int, text_chars: int = 1_200) -> RawCapture:
    payload = _raw_payload()
    segments = [
        {
            "segmentId": f"page-{index + 1}",
            "order": index,
            "locator": {"kind": "page", "page": index + 1},
            "text": f"segment-{index}-" + ("x" * text_chars),
        }
        for index in range(count)
    ]
    payload["segments"] = segments
    payload["sourceText"] = "\n".join(str(segment["text"]) for segment in segments)
    return RawCapture.model_validate(payload)


def _operation_payload(
    *,
    status: str = "awaiting_structuring",
) -> dict[str, object]:
    terminal = status in {"completed", "failed", "cancelled"}
    return {
        "protocolVersion": "2",
        "captureId": "capture-1",
        "ingestionId": "ingestion-1",
        "kind": "pdf",
        "status": status,
        "progress": 1 if terminal else 0.7,
        "partialRevision": 1,
        "lastEventSequence": 1,
        "source": _raw_payload()["source"],
        "error": None,
        "createdAt": NOW.isoformat(),
        "updatedAt": NOW.isoformat(),
        "completedAt": NOW.isoformat() if terminal else None,
    }


def _operation(*, status: str = "awaiting_structuring") -> CaptureOperation:
    return CaptureOperation.model_validate(_operation_payload(status=status))


def _ready_payload(*, schema_version: str = "2") -> dict[str, object]:
    return {
        "ready": True,
        "service": "capture-runtime",
        "apiVersion": "2.0",
        "runtimeVersion": CAPTURE_RUNTIME_VERSION,
        "captureDocumentSchemaVersion": schema_version,
        "capabilities": {
            "captureKinds": ["pdf", "image", "audio"],
            "structuringModes": ["runtime", "host"],
            "supportsCancellation": True,
            "supportsRawDiagnostics": True,
            "maxUploadBytes": 50 * 1024 * 1024,
        },
        "message": None,
    }


def _negotiated_handler(
    handler: Callable[[httpx.Request], httpx.Response],
) -> Callable[[httpx.Request], httpx.Response]:
    packaged = files("capture_runtime_client.private.assets")
    bundle = packaged.joinpath("contract-set.json").read_bytes()
    digest = hashlib.sha256(bundle).hexdigest()
    href = f"/meta/v2/contracts/sha256/{digest}"

    def wrapped(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v2/health/ready":
            return httpx.Response(200, json=_ready_payload(), request=request)
        if request.url.path == "/meta/v2/contracts":
            return httpx.Response(
                200,
                json={
                    "catalogVersion": "2",
                    "runtimeVersion": CAPTURE_RUNTIME_VERSION,
                    "contractSetVersion": "2",
                    "surfaces": [{"id": "v2"}],
                    "sha256": digest,
                    "href": href,
                },
                request=request,
            )
        if request.url.path == href:
            return httpx.Response(
                200,
                content=bundle,
                headers={"X-Contract-SHA256": digest, "ETag": f'"{digest}"'},
                request=request,
            )
        if request.url.path == "/v2/streaming/health/ready":
            return httpx.Response(
                200,
                json={
                    "protocolVersion": "2",
                    "captureKinds": ["pdf", "image", "audio"],
                    "supportsProgressiveAudio": True,
                    "maxChunkBytes": 1_048_576,
                    "checkpointIntervalMs": 500,
                    "heartbeatIntervalMs": 1_000,
                    "stallTimeoutMs": 30_000,
                },
                request=request,
            )
        return handler(request)

    return wrapped


def _document_payload() -> dict[str, object]:
    raw = _raw_payload()
    segment = raw["segments"][0]
    assert isinstance(segment, dict)
    return {
        "schemaVersion": "2",
        "source": raw["source"],
        "rawSegments": raw["segments"],
        "blocks": [
            {
                "blockId": "block-1",
                "order": 0,
                "type": "paragraph",
                "sourceSegmentId": segment["segmentId"],
                "locator": segment["locator"],
                "sourceText": segment["text"],
                "targetText": "Visible target text",
            }
        ],
        "sourceText": raw["sourceText"],
        "targetText": "Visible target text",
        "extractionEngine": raw["extractionEngine"],
        "structuringEngine": {
            "engine": "ollama",
            "model": "cert-prep-qwen",
            "digest": f"sha256:{'c' * 64}",
        },
        "warnings": [],
        "createdAt": raw["createdAt"],
        "completedAt": NOW.isoformat(),
    }


class RecordingStructuredProvider:
    provider = "test-provider"
    model = "test-model"
    profile_selection = SimpleNamespace(modelfile_sha256="d" * 64)

    def __init__(
        self,
        candidate: str | Callable[[dict[str, object]], str],
    ) -> None:
        self.candidate = candidate
        self.calls: list[dict[str, object]] = []

    def generate_structured_json(self, **kwargs) -> str:
        self.calls.append(kwargs)
        if callable(self.candidate):
            return self.candidate(kwargs)
        return self.candidate


class PullSessionRuntime:
    """Typed pull-session stand-in used by adapter regression tests.

    The stand-in deliberately reconstructs the document from submitted
    semantic blocks, mirroring the authenticated runtime boundary instead of
    importing or emulating the retired standalone package.
    """

    def __init__(self, raw: RawCapture) -> None:
        self.raw = raw
        self.open_calls: list[dict[str, object]] = []
        self.pull_calls: list[int] = []
        self.submit_calls: list[dict[str, object]] = []
        self._request = None
        self._session: StructuringSession | None = None
        self._document: CaptureDocument | None = None

    def open_structuring_session(
        self,
        capture_id: str,
        request,
        *,
        idempotency_key: str,
    ) -> StructuringSession:
        self.open_calls.append(
            {
                "capture_id": capture_id,
                "request": request,
                "idempotency_key": idempotency_key,
            }
        )
        self._request = request
        now = NOW
        self._session = StructuringSession.model_validate(
            {
                "sessionId": "session-1",
                "captureId": capture_id,
                "rawSourceSha256": self.raw.source.sha256,
                "contractSetSha256": "c" * 64,
                "targetLanguage": request.target_language,
                "providerCapability": request.provider_capability.model_dump(
                    mode="json", by_alias=True
                ),
                "schemaDialect": request.schema_dialect,
                "batchCount": len(self.raw.segments),
                "nextBatchIndex": 0,
                "sessionDigest": "d" * 64,
                "status": StructuringSessionStatus.OPEN,
                "createdAt": now,
                "updatedAt": now,
            }
        )
        return self._session

    def pull_structuring_batch(self, capture_id: str, batch_index: int) -> StructuringBatch:
        assert self._session is not None
        self.pull_calls.append(batch_index)
        segment = self.raw.segments[batch_index]
        return StructuringBatch.model_validate(
            {
                "sessionId": self._session.session_id,
                "captureId": capture_id,
                "batchIndex": batch_index,
                "batchCount": self._session.batch_count,
                "sourceSegmentIds": [segment.segment_id],
                "providerPrompt": {
                    "targetLanguage": self._request.target_language if self._request else None,
                    "rawSegments": [segment.model_dump(mode="json", by_alias=True)],
                },
                "providerSchema": {
                    "title": "CaptureBlockBatch",
                    "type": "object",
                    "properties": {
                        "blocks": {"type": "array", "items": {"type": "object"}}
                    },
                    "required": ["blocks"],
                    "additionalProperties": False,
                },
                "numCtx": 8_192,
                "numPredict": 4_096,
                "batchDigest": f"{batch_index + 1:064x}",
                "status": StructuringBatchStatus.READY,
            }
        )

    def submit_structuring_batch(
        self,
        capture_id: str,
        batch_index: int,
        submission,
        *,
        idempotency_key: str,
    ) -> StructuringSession:
        assert self._session is not None
        assert batch_index == self._session.next_batch_index
        self.submit_calls.append(
            {
                "capture_id": capture_id,
                "batch_index": batch_index,
                "submission": submission,
                "idempotency_key": idempotency_key,
            }
        )
        next_index = batch_index + 1
        status = (
            StructuringSessionStatus.COMPLETED
            if next_index == self._session.batch_count
            else StructuringSessionStatus.OPEN
        )
        self._session = self._session.model_copy(
            update={
                "next_batch_index": next_index,
                "status": status,
                "updated_at": NOW,
                "completed_at": NOW if status is StructuringSessionStatus.COMPLETED else None,
            }
        )
        if status is StructuringSessionStatus.COMPLETED:
            self._document = self._reconstruct_document()
        return self._session

    def get_result(self, capture_id: str) -> RuntimeStreamingResult:
        assert self._session is not None
        assert self._document is not None
        operation = CaptureOperation.model_validate(
            {
                **_operation_payload(status="completed"),
                "captureId": capture_id,
                "source": self.raw.source.model_dump(mode="json", by_alias=True),
            }
        )
        return RuntimeStreamingResult(operation=operation, raw=self.raw, result=self._document)

    def get_capture(self, capture_id: str) -> CaptureOperation:
        return self.get_result(capture_id).operation

    def commit_structure(self, *_args, **_kwargs):
        raise AssertionError("pull-session commit must not post a legacy full document")

    def _reconstruct_document(self) -> CaptureDocument:
        assert self._session is not None
        submitted = [
            block
            for call in self.submit_calls
            for block in call["submission"].blocks
        ]
        by_segment = {block.source_segment_id: block for block in submitted}
        blocks = []
        for segment in self.raw.segments:
            semantic = by_segment[segment.segment_id]
            blocks.append(
                {
                    "blockId": f"runtime-block-{segment.segment_id}",
                    "order": segment.order,
                    "type": semantic.type,
                    "sourceSegmentId": segment.segment_id,
                    "locator": segment.locator.model_dump(mode="json", by_alias=True),
                    "sourceText": segment.text,
                    "targetText": semantic.target_text or segment.text,
                }
            )
        target_text = "\n".join(str(block["targetText"]) for block in blocks)
        return CaptureDocument.model_validate(
            {
                "schemaVersion": self.raw.schema_version,
                "source": self.raw.source.model_dump(mode="json", by_alias=True),
                "rawSegments": [
                    segment.model_dump(mode="json", by_alias=True)
                    for segment in self.raw.segments
                ],
                "blocks": blocks,
                "sourceText": self.raw.source_text,
                "targetText": target_text,
                "extractionEngine": self.raw.extraction_engine.model_dump(
                    mode="json", by_alias=True
                ),
                "structuringEngine": self._session.provider_capability.provider.model_dump(
                    mode="json", by_alias=True
                ),
                "warnings": self.raw.warnings,
                "createdAt": self.raw.created_at,
                "completedAt": NOW,
            }
        )


def _valid_batch_candidate(call: dict[str, object]) -> str:
    messages = call["messages"]
    assert isinstance(messages, list)
    prompt = json.loads(messages[1]["content"])
    blocks = []
    for segment in prompt["rawSegments"]:
        blocks.append(
            {
                "type": "transcript" if segment["locator"]["kind"] == "time" else "paragraph",
                "sourceSegmentId": segment["segmentId"],
                "targetText": f"Target: {segment['text']}",
            }
        )
    return json.dumps({"blocks": blocks}, ensure_ascii=False)


def test_capture_adapter_strictly_validates_batches_and_assembles_full_document() -> None:
    provider = RecordingStructuredProvider(_valid_batch_candidate)
    raw = RawCapture.model_validate(_raw_payload())
    runtime = PullSessionRuntime(raw)
    adapter = CertPrepCaptureStructuringAdapter(provider, runtime, clock=lambda: NOW)

    candidate = CaptureDocument.model_validate(
        adapter.structure(
            raw,
            capture_id="capture-1",
            operation_id="operation-1",
            target_language="zh-TW",
        )
    )

    assert candidate.raw_segments == raw.segments
    assert candidate.source_text == raw.source_text
    assert candidate.blocks[0].target_text == "Target: Visible source text"
    assert candidate.target_text == "Target: Visible source text"
    assert len(provider.calls) == 1
    call = provider.calls[0]
    schema = call["json_schema"]
    assert isinstance(schema, dict)
    assert schema["title"] == "CaptureBlockBatch"
    assert set(schema["properties"]) == {"blocks"}
    messages = call["messages"]
    assert isinstance(messages, list)
    prompt = json.loads(messages[1]["content"])
    assert prompt["targetLanguage"] == "zh-TW"
    assert prompt["rawSegments"] == [
        segment.model_dump(mode="json", by_alias=True) for segment in raw.segments
    ]
    assert call["num_ctx"] <= 8_192
    assert call["num_predict"] <= 4_096
    assert runtime.pull_calls == [0]
    assert len(runtime.submit_calls) == 1


def test_capture_adapter_projects_ocr_without_llm_when_no_target_language_is_requested() -> None:
    provider = RecordingStructuredProvider(_valid_batch_candidate)
    raw = RawCapture.model_validate(_raw_payload())
    adapter = CertPrepCaptureStructuringAdapter(provider, clock=lambda: NOW)

    candidate = CaptureDocument.model_validate(adapter.structure(raw))

    assert provider.calls == []
    assert candidate.target_text == raw.source_text
    assert candidate.blocks[0].type == "paragraph"
    assert candidate.blocks[0].target_text == candidate.blocks[0].source_text
    assert candidate.structuring_engine.model == "capture-document-pass-through-v1"


def test_capture_adapter_does_not_repair_invalid_provider_json() -> None:
    provider = RecordingStructuredProvider('```json\n{"blocks": []}\n```')
    raw = RawCapture.model_validate(_raw_payload())
    adapter = CertPrepCaptureStructuringAdapter(
        provider, PullSessionRuntime(raw), clock=lambda: NOW
    )

    with pytest.raises(ValueError, match="not valid JSON|valid JSON object"):
        adapter.structure(
            raw,
            capture_id="capture-1",
            operation_id="operation-1",
            target_language="zh-TW",
        )


def test_capture_adapter_batches_by_token_budget_and_preserves_global_order() -> None:
    provider = RecordingStructuredProvider(_valid_batch_candidate)
    raw = _raw_with_segments(count=5)
    runtime = PullSessionRuntime(raw)
    adapter = CertPrepCaptureStructuringAdapter(
        provider,
        runtime,
        clock=lambda: NOW,
        num_ctx=4_096,
        num_predict=1_024,
    )

    document = CaptureDocument.model_validate(
        adapter.structure(
            raw,
            capture_id="capture-1",
            operation_id="operation-1",
            target_language="zh-TW",
        )
    )

    assert len(provider.calls) >= 2
    supplied_ids = []
    for call in provider.calls:
        messages = call["messages"]
        assert isinstance(messages, list)
        prompt = json.loads(messages[1]["content"])
        supplied_ids.extend(segment["segmentId"] for segment in prompt["rawSegments"])
        assert call["num_ctx"] <= 4_096
        assert call["num_predict"] <= 1_024
    assert supplied_ids == [segment.segment_id for segment in raw.segments]
    assert [block.order for block in document.blocks] == list(range(5))
    assert [block.source_segment_id for block in document.blocks] == supplied_ids
    assert runtime.pull_calls == list(range(5))


@pytest.mark.parametrize("mutation", ["count", "sourceSegmentId", "forbidden"])
def test_capture_adapter_rejects_mutated_batch_provenance(mutation: str) -> None:
    def invalid_candidate(call: dict[str, object]) -> str:
        payload = json.loads(_valid_batch_candidate(call))
        blocks = payload["blocks"]
        if mutation == "count":
            blocks.pop()
        elif mutation == "sourceSegmentId":
            blocks[0]["sourceSegmentId"] = "forged-segment"
        else:
            blocks[0]["sourceText"] = "forbidden echo"
        return json.dumps(payload)

    provider = RecordingStructuredProvider(invalid_candidate)
    raw = RawCapture.model_validate(_raw_payload())
    adapter = CertPrepCaptureStructuringAdapter(
        provider, PullSessionRuntime(raw), clock=lambda: NOW
    )

    with pytest.raises(ValueError):
        adapter.structure(
            raw,
            capture_id="capture-1",
            operation_id="operation-1",
            target_language="zh-TW",
        )


def test_capture_adapter_uses_runtime_batch_budget_without_replanning() -> None:
    provider = RecordingStructuredProvider(_valid_batch_candidate)
    raw = _raw_with_segments(count=1, text_chars=20_000)
    runtime = PullSessionRuntime(raw)
    adapter = CertPrepCaptureStructuringAdapter(
        provider,
        runtime,
        clock=lambda: NOW,
        num_ctx=1_024,
        num_predict=512,
    )

    adapter.structure(
        raw,
        capture_id="capture-1",
        operation_id="operation-1",
        target_language="zh-TW",
    )

    assert provider.calls[0]["num_ctx"] == 1_024
    assert provider.calls[0]["num_predict"] == 512


def test_capture_adapter_observes_cancellation_between_provider_batches() -> None:
    cancelled = False

    def candidate_then_cancel(call: dict[str, object]) -> str:
        nonlocal cancelled
        candidate = _valid_batch_candidate(call)
        cancelled = True
        return candidate

    provider = RecordingStructuredProvider(candidate_then_cancel)
    raw = _raw_with_segments(count=5)
    adapter = CertPrepCaptureStructuringAdapter(
        provider,
        PullSessionRuntime(raw),
        clock=lambda: NOW,
        num_ctx=4_096,
        num_predict=1_024,
    )

    with pytest.raises(CaptureStructuringCanceledError):
        adapter.structure(
            raw,
            capture_id="capture-1",
            operation_id="operation-1",
            target_language="zh-TW",
            should_cancel=lambda: cancelled,
        )

    assert len(provider.calls) == 1


def test_capture_adapter_observes_deadline_after_an_in_flight_batch_returns() -> None:
    provider = RecordingStructuredProvider(_valid_batch_candidate)
    raw = RawCapture.model_validate(_raw_payload())
    ticks = iter([0.0, 0.0, 2.0])
    adapter = CertPrepCaptureStructuringAdapter(
        provider, PullSessionRuntime(raw), clock=lambda: NOW
    )

    with pytest.raises(CaptureStructuringTimeoutError):
        adapter.structure(
            raw,
            capture_id="capture-1",
            operation_id="operation-1",
            target_language="zh-TW",
            deadline=1.0,
            monotonic_clock=lambda: next(ticks),
        )

    assert len(provider.calls) == 1


def test_capture_adapter_reuses_existing_ollama_client_and_model() -> None:
    raw = RawCapture.model_validate(_raw_payload())
    segment = raw.segments[0].model_dump(mode="json", by_alias=True)
    candidate = json.dumps(
        {
            "blocks": [
                {
                    "sourceSegmentId": segment["segmentId"],
                    "type": "paragraph",
                    "targetText": "Visible target text",
                }
            ]
        }
    )
    ollama_client = RecordingOllamaClient(
        models=["cert-prep-qwen"],
        chat_content=candidate,
    )
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="cert-prep-qwen",
        timeout_seconds=1,
        client=ollama_client,
    )
    factory_calls = 0

    def provider_factory() -> OllamaProvider:
        nonlocal factory_calls
        factory_calls += 1
        return provider

    lazy_provider = LazyDraftGenerationProvider(
        provider_factory,
        provider="ollama",
        model="cert-prep-qwen",
    )
    adapter = CertPrepCaptureStructuringAdapter(
        lazy_provider, PullSessionRuntime(raw), clock=lambda: NOW
    )

    result = CaptureDocument.model_validate(
        adapter.structure(
            raw,
            capture_id="capture-1",
            operation_id="operation-1",
            target_language="zh-TW",
        )
    )

    assert factory_calls == 1
    assert result.blocks[0].target_text == "Visible target text"
    assert result.raw_segments == raw.segments
    assert len(ollama_client.chat_calls) == 1
    call = ollama_client.chat_calls[0]
    assert call["model"] == "cert-prep-qwen"
    assert call["think"] is False
    assert call["format"]["title"] == "CaptureBlockBatch"


def test_capture_adapter_has_no_hidden_provider_fallback() -> None:
    class DraftOnlyProvider:
        provider = "fake"
        model = "fake-model"

    raw = RawCapture.model_validate(_raw_payload())
    adapter = CertPrepCaptureStructuringAdapter(
        DraftOnlyProvider(), PullSessionRuntime(raw), clock=lambda: NOW
    )

    with pytest.raises(ProviderUnavailableError, match="cannot produce structured JSON"):
        adapter.structure(
            raw,
            capture_id="capture-1",
            operation_id="operation-1",
            target_language="zh-TW",
        )


def test_coordinator_accepts_only_review_overlay_after_pull_session_completion() -> None:
    raw = RawCapture.model_validate(_raw_payload())
    provider = RecordingStructuredProvider(_valid_batch_candidate)
    runtime = PullSessionRuntime(raw)
    adapter = CertPrepCaptureStructuringAdapter(provider, runtime, clock=lambda: NOW)
    base_document = adapter.structure(
        raw,
        capture_id="capture-1",
        operation_id="operation-1",
        target_language="zh-TW",
    )
    candidate_payload = base_document.model_dump(mode="json", by_alias=True)
    candidate_payload["blocks"][0]["targetText"] = "Reviewed target text"
    candidate_payload["targetText"] = "Reviewed target text"
    candidate = CaptureDocument.model_validate(candidate_payload)

    coordinator = CertPrepCaptureCoordinator(
        client=runtime,
        structurer=adapter,
        clock=lambda: 0.0,
        sleeper=lambda _seconds: None,
    )
    result = coordinator.commit_capture(
        operation_id="operation-1",
        capture_id="capture-1",
        candidate=candidate,
        should_cancel=lambda: False,
    )

    assert result.document.blocks[0].target_text == "Reviewed target text"
    assert result.document.target_text == "Reviewed target text"


def test_contract_rejects_changed_locator_before_host_consumption() -> None:
    payload = _document_payload()
    payload["blocks"][0]["locator"] = {"kind": "page", "page": 99}

    with pytest.raises(ValidationError, match="locator must equal"):
        CaptureDocument.model_validate(payload)


def test_sidecar_client_submits_invalid_candidate_verbatim_for_canonical_failure() -> None:
    candidate = "{not-json"

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v2/captures/capture-1/structure/commit"
        assert request.content == candidate.encode()
        assert request.headers["x-idempotency-key"] == str(IDEMPOTENCY_KEY)
        return httpx.Response(
            422,
            json={
                "error": {
                    "code": "invalid_structure",
                    "message": "Candidate failed strict validation.",
                }
            },
        )

    client = CaptureRuntimeClient(
        base_url="http://127.0.0.1:43123",
        bearer_token=TOKEN,
        client=httpx.Client(transport=httpx.MockTransport(_negotiated_handler(handler))),
    )

    with pytest.raises(CaptureRuntimeError) as raised:
        client.commit_structure(
            "capture-1",
            candidate,
            idempotency_key=IDEMPOTENCY_KEY,
        )

    assert raised.value.code == "invalid_structure"
    assert raised.value.status_code == 422


@pytest.mark.parametrize(
    "base_url",
    [
        "https://127.0.0.1:43123",
        "http://localhost:43123",
        "http://token@127.0.0.1:43123",
        "http://127.0.0.1:43123/path",
        "http://127.0.0.1:43123?token=secret",
    ],
)
def test_sidecar_client_rejects_noncanonical_or_credentialed_urls(base_url: str) -> None:
    with pytest.raises(CaptureRuntimeError) as raised:
        CaptureRuntimeClient(base_url=base_url, bearer_token=TOKEN)
    assert raised.value.code == "unsafe_base_url"


def test_sidecar_client_rejects_incompatible_schema() -> None:
    transport = httpx.MockTransport(
        lambda _request: httpx.Response(200, json=_ready_payload(schema_version="3"))
    )
    client = CaptureRuntimeClient(
        base_url="http://127.0.0.1:43123",
        bearer_token=TOKEN,
        client=httpx.Client(transport=transport),
    )

    with pytest.raises(CaptureRuntimeCompatibilityError, match="schema version"):
        client.handshake()


def test_sidecar_client_rejects_incompatible_runtime_release() -> None:
    payload = _ready_payload()
    payload["runtimeVersion"] = "0.2.8"
    transport = httpx.MockTransport(
        lambda _request: httpx.Response(200, json=payload)
    )
    client = CaptureRuntimeClient(
        base_url="http://127.0.0.1:43123",
        bearer_token=TOKEN,
        client=httpx.Client(transport=transport),
    )

    with pytest.raises(
        CaptureRuntimeCompatibilityError,
        match="runtime version 0.2.8 is incompatible with 0.4.0",
    ):
        client.handshake()


def test_sidecar_client_requires_the_coordinated_runtime_release() -> None:
    payload = _ready_payload()
    payload["runtimeVersion"] = "0.3.8"
    transport = httpx.MockTransport(
        lambda _request: httpx.Response(200, json=payload)
    )
    client = CaptureRuntimeClient(
        base_url="http://127.0.0.1:43123",
        bearer_token=TOKEN,
        client=httpx.Client(transport=transport),
    )

    with pytest.raises(CaptureRuntimeCompatibilityError, match="incompatible with 0.4.0"):
        client.handshake()


class RecordingCaptureRuntime:
    def __init__(
        self,
        *,
        initial_operation: dict[str, object] | None = None,
        capture_kinds: list[str] | None = None,
        requirement_status: RuntimeRequirementStatus = RuntimeRequirementStatus.READY,
        runtime_version: str = CAPTURE_RUNTIME_VERSION,
    ) -> None:
        self.initial_operation = CaptureOperation.model_validate(
            initial_operation or _operation_payload()
        )
        self.raw = RawCapture.model_validate(_raw_payload())
        self.document = CaptureDocument.model_validate(_document_payload())
        ready = _ready_payload()
        ready["runtimeVersion"] = runtime_version
        ready["capabilities"]["captureKinds"] = capture_kinds or ["pdf", "image", "audio"]
        self.ready = RuntimeReady.model_validate(ready)
        detail = (
            None
            if requirement_status is RuntimeRequirementStatus.READY
            else "No downloadable model is published for this runtime release."
        )
        self.requirements = RuntimeRequirements.model_validate(
            {
                "items": [
                    {
                        "requirementId": "windowsml-ocr",
                        "kind": "ocr",
                        "displayName": "WindowsML OCR",
                        "status": requirement_status.value,
                        "requiredFor": ["pdf", "image"],
                        "installStrategy": "unavailable",
                        "detail": detail,
                    },
                    {
                        "requirementId": "whisper-primary",
                        "kind": "speech-to-text",
                        "displayName": "Whisper",
                        "status": requirement_status.value,
                        "requiredFor": ["audio"],
                        "installStrategy": "unavailable",
                        "detail": detail,
                    },
                ]
            }
        )
        self.handshakes = 0
        self.requirement_reads = 0
        self.creates = 0
        self.commits: list[tuple[str, object, UUID]] = []
        self.cancellations: list[str] = []
        self.failures: list[tuple[str, str, str]] = []
        self.deleted: list[str] = []

    def handshake(self):
        self.handshakes += 1
        return self.ready

    def get_requirements(self):
        self.requirement_reads += 1
        return self.requirements

    def start_capture(
        self,
        _upload: CaptureUpload,
        *,
        source_kind: CaptureSourceKind,
        client_request_id: str,
        target_language: str | None = None,
    ) -> CaptureOperation:
        self.creates += 1
        self.create_args = (source_kind, client_request_id, target_language)
        return self.initial_operation

    def get_capture(self, _capture_id: str) -> CaptureOperation:
        return _operation(status="completed")

    def get_partial(self, capture_id: str) -> PartialCapture:
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

    def get_raw(self, _capture_id):
        return self.raw

    def commit_structure(self, capture_id, candidate, *, idempotency_key):
        self.commits.append((capture_id, candidate, idempotency_key))
        return _operation(status="completed")

    def get_result(self, _capture_id):
        return CaptureStreamingResult(
            operation=_operation(status="completed"),
            raw=self.raw,
            result=self.document,
        )

    def report_structuring_failure(
        self,
        capture_id,
        *,
        code,
        message,
        idempotency_key,
    ):
        del idempotency_key
        self.failures.append((capture_id, code, message))
        failed = _operation_payload(status="failed")
        failed["error"] = {
            "code": code,
            "message": message,
            "stage": "structuring",
            "retryable": False,
        }
        return CaptureOperation.model_validate(failed)

    def cancel_capture(self, capture_id):
        self.cancellations.append(capture_id)
        return _operation(status="cancelled")

    def delete_capture(self, capture_id):
        self.deleted.append(capture_id)


class ReconciliationCaptureRuntime(RecordingCaptureRuntime):
    def __init__(
        self,
        *,
        commits: list[CaptureOperation | Exception] | None = None,
        failures: list[CaptureOperation | Exception] | None = None,
        cancellations: list[CaptureOperation | Exception] | None = None,
        reads: list[CaptureOperation | Exception] | None = None,
    ) -> None:
        super().__init__()
        self.commit_outcomes = list(commits or [])
        self.failure_outcomes = list(failures or [])
        self.cancellation_outcomes = list(cancellations or [])
        self.read_outcomes = list(reads or [])
        self.capture_reads = 0

    @staticmethod
    def _outcome(
        outcomes: list[CaptureOperation | Exception],
    ) -> CaptureOperation:
        outcome = outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def get_capture(self, capture_id):
        self.capture_reads += 1
        if self.read_outcomes:
            return self._outcome(self.read_outcomes)
        return super().get_capture(capture_id)

    def commit_structure(self, capture_id, candidate, *, idempotency_key):
        if not self.commit_outcomes:
            return super().commit_structure(
                capture_id,
                candidate,
                idempotency_key=idempotency_key,
            )
        self.commits.append((capture_id, candidate, idempotency_key))
        return self._outcome(self.commit_outcomes)

    def report_structuring_failure(
        self,
        capture_id,
        *,
        code,
        message,
        idempotency_key,
    ):
        if not self.failure_outcomes:
            return super().report_structuring_failure(
                capture_id,
                code=code,
                message=message,
                idempotency_key=idempotency_key,
            )
        self.failures.append((capture_id, code, message))
        return self._outcome(self.failure_outcomes)

    def cancel_capture(self, capture_id):
        if not self.cancellation_outcomes:
            return super().cancel_capture(capture_id)
        self.cancellations.append(capture_id)
        return self._outcome(self.cancellation_outcomes)


class StaticStructurer:
    def __init__(self, candidate: object) -> None:
        self.candidate = candidate
        self.calls: list[tuple[RawCapture, str | None]] = []

    def structure(
        self,
        raw: RawCapture,
        *,
        target_language: str | None = None,
        **_control,
    ):
        self.calls.append((raw, target_language))
        if isinstance(self.candidate, Exception):
            raise self.candidate
        return self.candidate


def _run_capture(
    coordinator: CertPrepCaptureCoordinator,
    *,
    operation_id: str,
    should_cancel: Callable[[], bool] = lambda: False,
) -> CaptureRunResult:
    return coordinator.capture(
        operation_id=operation_id,
        file_name="sample.pdf",
        content=b"PDF bytes",
        media_type="application/pdf",
        source_kind=CaptureSourceKind.PDF,
        target_language=None,
        should_cancel=should_cancel,
    )


def test_capture_coordinator_uses_host_provider_then_fetches_validated_result() -> None:
    runtime = RecordingCaptureRuntime()
    structurer = StaticStructurer(json.dumps(_document_payload()))
    coordinator = CertPrepCaptureCoordinator(
        client=runtime,
        structurer=structurer,
        reconciliation_interval_seconds=0.01,
    )

    result = coordinator.capture(
        operation_id="cert-operation-1",
        file_name="sample.pdf",
        content=b"PDF bytes",
        media_type="application/pdf",
        source_kind=CaptureSourceKind.PDF,
        target_language=None,
        should_cancel=lambda: False,
    )

    assert runtime.handshakes == 1
    assert result.document == runtime.document
    assert result.raw.diagnostic_only is True
    assert len(runtime.commits) == 1
    assert runtime.create_args[1] == "cert-operation-1"
    assert runtime.commits[0][2] != runtime.create_args[1]
    assert runtime.deleted == []
    coordinator.delete(result.capture_id)
    assert runtime.deleted == ["capture-1"]


@pytest.mark.parametrize(
    ("source_kind", "file_name", "media_type", "expected_message"),
    [
        (
            CaptureSourceKind.IMAGE,
            "sample.png",
            "image/png",
            "WindowsML OCR is unavailable. No downloadable model is published for this runtime release.",
        ),
        (
            CaptureSourceKind.AUDIO,
            "sample.wav",
            "audio/wav",
            "Whisper transcription is unavailable. No downloadable model is published for this runtime release.",
        ),
    ],
)
def test_capture_coordinator_rejects_nonready_source_requirement_before_dispatch(
    source_kind: CaptureSourceKind,
    file_name: str,
    media_type: str,
    expected_message: str,
) -> None:
    runtime = RecordingCaptureRuntime(
        requirement_status=RuntimeRequirementStatus.UNAVAILABLE
    )
    coordinator = CertPrepCaptureCoordinator(
        client=runtime,
        structurer=StaticStructurer(_document_payload()),
    )

    with pytest.raises(
        CaptureRuntimeRequirementUnavailableError,
        match=expected_message.replace(".", r"\."),
    ) as raised:
        coordinator.begin_capture(
            operation_id=f"blocked-{source_kind.value}",
            file_name=file_name,
            content=b"source bytes",
            media_type=media_type,
            source_kind=source_kind,
            target_language="zh-Hant" if source_kind is CaptureSourceKind.AUDIO else None,
            should_cancel=lambda: False,
        )

    assert raised.value.source_kind is source_kind
    assert runtime.handshakes == 1
    assert runtime.requirement_reads == 1
    assert runtime.creates == 0


def test_capture_coordinator_rejects_unsupported_source_kind_before_requirement_lookup() -> None:
    runtime = RecordingCaptureRuntime(capture_kinds=["pdf"])
    coordinator = CertPrepCaptureCoordinator(
        client=runtime,
        structurer=StaticStructurer(_document_payload()),
    )

    with pytest.raises(
        CaptureRuntimeCompatibilityError,
        match="does not support IMAGE capture",
    ):
        coordinator.begin_capture(
            operation_id="unsupported-image",
            file_name="sample.png",
            content=b"source bytes",
            media_type="image/png",
            source_kind=CaptureSourceKind.IMAGE,
            target_language=None,
            should_cancel=lambda: False,
        )

    assert runtime.handshakes == 1
    assert runtime.requirement_reads == 0
    assert runtime.creates == 0


def test_future_runtime_generic_pdf_extraction_failure_is_not_reclassified() -> None:
    failed = _operation_payload(status="failed")
    failed["error"] = {
        "code": "extraction_failed",
        "message": "Source extraction failed.",
        "stage": "extraction",
        "retryable": True,
    }
    runtime = RecordingCaptureRuntime(
        initial_operation=failed,
        requirement_status=RuntimeRequirementStatus.UNAVAILABLE,
        runtime_version=CAPTURE_RUNTIME_VERSION,
    )
    coordinator = CertPrepCaptureCoordinator(
        client=runtime,
        structurer=StaticStructurer(_document_payload()),
    )

    with pytest.raises(CaptureRuntimeJobError, match="Source extraction failed"):
        coordinator.begin_capture(
            operation_id="future-runtime-extraction-failure",
            file_name="sample.pdf",
            content=b"PDF bytes",
            media_type="application/pdf",
            source_kind=CaptureSourceKind.PDF,
            target_language=None,
            should_cancel=lambda: False,
        )

    assert runtime.requirement_reads == 0


def test_capture_coordinator_reconciles_lost_commit_response() -> None:
    runtime = ReconciliationCaptureRuntime(
        commits=[_lost_response("commit response was lost")],
        reads=[_operation(status="completed")],
    )
    coordinator = CertPrepCaptureCoordinator(
        client=runtime,
        structurer=StaticStructurer(_document_payload()),
        sleeper=lambda _seconds: None,
    )

    result = _run_capture(coordinator, operation_id="cert-operation-lost-commit")

    assert result.document == runtime.document
    assert len(runtime.commits) == 1
    assert runtime.capture_reads == 1


def test_capture_coordinator_retries_commit_with_the_same_key_only_while_awaiting() -> None:
    runtime = ReconciliationCaptureRuntime(
        commits=[
            _lost_response("first commit response was lost"),
            _operation(status="completed"),
        ],
        reads=[_operation()],
    )
    coordinator = CertPrepCaptureCoordinator(
        client=runtime,
        structurer=StaticStructurer(_document_payload()),
        sleeper=lambda _seconds: None,
    )

    result = _run_capture(coordinator, operation_id="cert-operation-retry-commit")

    assert result.document == runtime.document
    assert len(runtime.commits) == 2
    assert runtime.commits[0][2] == runtime.commits[1][2]
    assert runtime.capture_reads == 1


@pytest.mark.parametrize(
    ("status", "expected_error"),
    [
        ("failed", CaptureRuntimeJobError),
        ("cancelled", CaptureRuntimeCanceledError),
    ],
)
def test_capture_coordinator_accepts_confirmed_terminal_commit_reconciliation(
    status: str,
    expected_error: type[Exception],
) -> None:
    runtime = ReconciliationCaptureRuntime(
        commits=[_lost_response("commit response was lost")],
        reads=[_operation(status=status)],
    )
    coordinator = CertPrepCaptureCoordinator(
        client=runtime,
        structurer=StaticStructurer(_document_payload()),
        sleeper=lambda _seconds: None,
    )

    with pytest.raises(expected_error):
        _run_capture(coordinator, operation_id=f"cert-operation-{status}-commit")

    assert len(runtime.commits) == 1
    assert runtime.capture_reads == 1


def test_capture_coordinator_reports_host_failure_without_deleting_raw() -> None:
    runtime = RecordingCaptureRuntime()
    coordinator = CertPrepCaptureCoordinator(
        client=runtime,
        structurer=StaticStructurer(RuntimeError("provider exploded")),
    )

    with pytest.raises(RuntimeError, match="provider exploded"):
        coordinator.capture(
            operation_id="cert-operation-2",
            file_name="sample.pdf",
            content=b"PDF bytes",
            media_type="application/pdf",
            source_kind=CaptureSourceKind.PDF,
            target_language=None,
            should_cancel=lambda: False,
        )

    assert runtime.failures[0][1] == "host_provider_failed"
    assert runtime.deleted == []


def test_capture_coordinator_reconciles_lost_failure_report_response() -> None:
    runtime = ReconciliationCaptureRuntime(
        failures=[_lost_response("failure-report response was lost")],
        reads=[_operation(status="failed")],
    )
    coordinator = CertPrepCaptureCoordinator(
        client=runtime,
        structurer=StaticStructurer(RuntimeError("provider exploded")),
    )

    with pytest.raises(RuntimeError, match="provider exploded"):
        _run_capture(coordinator, operation_id="cert-operation-lost-failure-report")

    assert runtime.failures[0][1] == "host_provider_failed"
    assert runtime.capture_reads == 1
    assert runtime.cancellations == []
    assert runtime.deleted == []


def test_capture_coordinator_cancels_and_confirms_when_failure_report_stays_awaiting() -> None:
    runtime = ReconciliationCaptureRuntime(
        failures=[_lost_response("failure-report response was lost")],
        cancellations=[_operation(status="cancelled")],
        reads=[
            _operation(),
            _operation(status="cancelled"),
        ],
    )
    coordinator = CertPrepCaptureCoordinator(
        client=runtime,
        structurer=StaticStructurer(RuntimeError("provider exploded")),
    )

    with pytest.raises(RuntimeError, match="provider exploded"):
        _run_capture(coordinator, operation_id="cert-operation-cancel-fallback")

    assert runtime.cancellations == ["capture-1"]
    assert runtime.capture_reads == 2
    assert runtime.deleted == []


def test_capture_coordinator_raises_when_failure_terminal_state_remains_unknown() -> None:
    runtime = ReconciliationCaptureRuntime(
        failures=[_lost_response("failure-report response was lost")],
        cancellations=[_lost_response("cancel response was lost")],
        reads=[_operation(), _operation()],
    )
    coordinator = CertPrepCaptureCoordinator(
        client=runtime,
        structurer=StaticStructurer(RuntimeError("provider exploded")),
    )

    with pytest.raises(
        CaptureRuntimeStateUnknownError,
        match="did not produce a confirmed terminal state",
    ) as raised:
        _run_capture(coordinator, operation_id="cert-operation-unknown-state")

    assert raised.value.capture_id == "capture-1"
    assert runtime.cancellations == ["capture-1"]
    assert runtime.capture_reads == 2
    assert runtime.deleted == []


def test_capture_coordinator_propagates_host_cancellation_to_sidecar() -> None:
    runtime = RecordingCaptureRuntime(
        initial_operation=_operation_payload(status="extracting")
    )
    checks = iter([False, True])
    coordinator = CertPrepCaptureCoordinator(
        client=runtime,
        structurer=StaticStructurer(json.dumps(_document_payload())),
        sleeper=lambda _seconds: None,
    )

    with pytest.raises(CaptureRuntimeCanceledError):
        coordinator.capture(
            operation_id="cert-operation-3",
            file_name="sample.pdf",
            content=b"PDF bytes",
            media_type="application/pdf",
            source_kind=CaptureSourceKind.PDF,
            target_language=None,
            should_cancel=lambda: next(checks),
        )

    assert runtime.cancellations == ["capture-1"]


@pytest.mark.parametrize(
    ("structuring_error", "expected_error"),
    [
        (CaptureStructuringCanceledError("cancelled"), CaptureRuntimeCanceledError),
        (CaptureStructuringTimeoutError("timed out"), CaptureRuntimeTimeoutError),
    ],
)
def test_capture_coordinator_maps_structuring_control_to_sidecar_cancel(
    structuring_error: Exception,
    expected_error: type[Exception],
) -> None:
    runtime = RecordingCaptureRuntime()
    coordinator = CertPrepCaptureCoordinator(
        client=runtime,
        structurer=StaticStructurer(structuring_error),
    )

    with pytest.raises(expected_error):
        coordinator.capture(
            operation_id="cert-operation-control",
            file_name="sample.pdf",
            content=b"PDF bytes",
            media_type="application/pdf",
            source_kind=CaptureSourceKind.PDF,
            target_language=None,
            should_cancel=lambda: False,
        )

    assert runtime.cancellations == ["capture-1"]
    assert runtime.failures == []


def test_capture_document_maps_page_and_time_provenance_without_restructuring() -> None:
    document = CaptureDocument.model_validate(_document_payload())
    extraction = capture_document_to_pdf_extraction(document)

    assert extraction.page_count == 1
    assert extraction.pages[0].page_number == 1
    assert extraction.pages[0].raw_text == "Visible source text"
    assert extraction.pages[0].text == "Visible target text"
    assert extraction.extraction_method == "windowsml_ocr"

    audio = _document_payload()
    audio["source"]["fileName"] = "sample.wav"
    audio["source"]["mediaType"] = "audio/wav"
    audio["rawSegments"][0]["locator"] = {
        "kind": "time",
        "startMs": 125,
        "endMs": 950,
    }
    audio["blocks"][0]["locator"] = audio["rawSegments"][0]["locator"]
    segments = capture_document_to_audio_segments(CaptureDocument.model_validate(audio))

    assert segments[0].transcript.start_ms == 125
    assert segments[0].transcript.end_ms == 950
    assert segments[0].target_text == "Visible target text"
