from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
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
    CaptureUpload,
)
from cert_prep_backend.domains.capture_workbench.contracts import (
    CaptureDocumentV1,
    CaptureJobV1,
    CaptureSourceKind,
    RawCaptureV1,
)
from cert_prep_backend.domains.capture_workbench.coordinator import (
    CaptureRunResult,
    CaptureRuntimeCanceledError,
    CaptureRuntimeJobError,
    CaptureRuntimeStateUnknownError,
    CaptureRuntimeTimeoutError,
    CertPrepCaptureCoordinator,
)
from cert_prep_backend.domains.capture_workbench.mapping import (
    capture_document_to_audio_segments,
    capture_document_to_pdf_extraction,
)
from cert_prep_backend.domains.capture_workbench.structuring import (
    CaptureStructuringBudgetError,
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
        request=httpx.Request("POST", "http://127.0.0.1:43123/v1/captures"),
    )


def _raw_payload() -> dict[str, object]:
    return {
        "schemaVersion": "1",
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


def _raw_with_segments(*, count: int, text_chars: int = 1_200) -> RawCaptureV1:
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
    return RawCaptureV1.model_validate(payload)


def _job_payload(
    *,
    status: str = "running",
    stage: str = "awaiting_structuring",
) -> dict[str, object]:
    return {
        "captureId": "capture-1",
        "status": status,
        "stage": stage,
        "structuringMode": "host",
        "progress": 0.7 if status == "running" else 1,
        "source": _raw_payload()["source"],
        "error": None,
        "createdAt": NOW.isoformat(),
        "updatedAt": NOW.isoformat(),
        "completedAt": NOW.isoformat() if status in {"completed", "failed", "cancelled"} else None,
    }


def _job(*, status: str = "running", stage: str = "awaiting_structuring") -> CaptureJobV1:
    return CaptureJobV1.model_validate(_job_payload(status=status, stage=stage))


def _ready_payload(*, schema_version: str = "1") -> dict[str, object]:
    return {
        "ready": True,
        "service": "capture-runtime",
        "apiVersion": "1.0",
        "runtimeVersion": "0.1.0",
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


def _document_payload() -> dict[str, object]:
    raw = _raw_payload()
    segment = raw["segments"][0]
    assert isinstance(segment, dict)
    return {
        "schemaVersion": "1",
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


def _valid_batch_candidate(call: dict[str, object]) -> str:
    messages = call["messages"]
    assert isinstance(messages, list)
    prompt = json.loads(messages[1]["content"])
    blocks = []
    for segment in prompt["rawSegments"]:
        blocks.append(
            {
                "blockId": f"block-{segment['segmentId']}",
                "order": segment["order"],
                "type": "transcript" if segment["locator"]["kind"] == "time" else "paragraph",
                "sourceSegmentId": segment["segmentId"],
                "locator": segment["locator"],
                "sourceText": segment["text"],
                "targetText": f"Target: {segment['text']}",
            }
        )
    return json.dumps({"blocks": blocks}, ensure_ascii=False)


def test_capture_adapter_strictly_validates_batches_and_assembles_full_document() -> None:
    provider = RecordingStructuredProvider(_valid_batch_candidate)
    raw = RawCaptureV1.model_validate(_raw_payload())
    adapter = CertPrepCaptureStructuringAdapter(provider, clock=lambda: NOW)

    candidate = CaptureDocumentV1.model_validate(adapter.structure(raw, target_language="zh-TW"))

    assert candidate.raw_segments == raw.segments
    assert candidate.source_text == raw.source_text
    assert candidate.blocks[0].target_text == "Target: Visible source text"
    assert candidate.target_text == "Target: Visible source text"
    assert len(provider.calls) == 1
    call = provider.calls[0]
    schema = call["json_schema"]
    assert isinstance(schema, dict)
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


def test_capture_adapter_does_not_repair_invalid_provider_json() -> None:
    provider = RecordingStructuredProvider('```json\n{"blocks": []}\n```')
    adapter = CertPrepCaptureStructuringAdapter(provider, clock=lambda: NOW)

    with pytest.raises(ValueError, match="valid JSON object"):
        adapter.structure(RawCaptureV1.model_validate(_raw_payload()))


def test_capture_adapter_batches_by_token_budget_and_preserves_global_order() -> None:
    provider = RecordingStructuredProvider(_valid_batch_candidate)
    raw = _raw_with_segments(count=5)
    adapter = CertPrepCaptureStructuringAdapter(provider, clock=lambda: NOW)

    document = CaptureDocumentV1.model_validate(adapter.structure(raw))

    assert len(provider.calls) >= 2
    supplied_ids = []
    for call in provider.calls:
        messages = call["messages"]
        assert isinstance(messages, list)
        prompt = json.loads(messages[1]["content"])
        supplied_ids.extend(segment["segmentId"] for segment in prompt["rawSegments"])
        assert call["num_ctx"] <= 8_192
        assert call["num_predict"] <= 4_096
    assert supplied_ids == [segment.segment_id for segment in raw.segments]
    assert [block.order for block in document.blocks] == list(range(5))
    assert [block.source_segment_id for block in document.blocks] == supplied_ids


@pytest.mark.parametrize("mutation", ["count", "order", "locator", "sourceText"])
def test_capture_adapter_rejects_mutated_batch_provenance(mutation: str) -> None:
    def invalid_candidate(call: dict[str, object]) -> str:
        payload = json.loads(_valid_batch_candidate(call))
        blocks = payload["blocks"]
        if mutation == "count":
            blocks.pop()
        elif mutation == "order":
            blocks[0]["order"] += 1
        elif mutation == "locator":
            blocks[0]["locator"]["page"] += 1
        else:
            blocks[0]["sourceText"] += " changed"
        return json.dumps(payload)

    provider = RecordingStructuredProvider(invalid_candidate)
    adapter = CertPrepCaptureStructuringAdapter(provider, clock=lambda: NOW)

    with pytest.raises(ValueError, match="batch|changed required field"):
        adapter.structure(RawCaptureV1.model_validate(_raw_payload()))


def test_capture_adapter_fails_before_generation_when_one_segment_exceeds_budget() -> None:
    provider = RecordingStructuredProvider(_valid_batch_candidate)
    raw = _raw_with_segments(count=1, text_chars=20_000)
    adapter = CertPrepCaptureStructuringAdapter(provider, clock=lambda: NOW)

    with pytest.raises(CaptureStructuringBudgetError, match="exceeds the provider token budget"):
        adapter.structure(raw)

    assert provider.calls == []


def test_capture_adapter_observes_cancellation_between_provider_batches() -> None:
    cancelled = False

    def candidate_then_cancel(call: dict[str, object]) -> str:
        nonlocal cancelled
        candidate = _valid_batch_candidate(call)
        cancelled = True
        return candidate

    provider = RecordingStructuredProvider(candidate_then_cancel)
    adapter = CertPrepCaptureStructuringAdapter(provider, clock=lambda: NOW)

    with pytest.raises(CaptureStructuringCanceledError):
        adapter.structure(
            _raw_with_segments(count=5),
            should_cancel=lambda: cancelled,
        )

    assert len(provider.calls) == 1


def test_capture_adapter_observes_deadline_after_an_in_flight_batch_returns() -> None:
    provider = RecordingStructuredProvider(_valid_batch_candidate)
    ticks = iter([0.0, 0.0, 2.0])
    adapter = CertPrepCaptureStructuringAdapter(provider, clock=lambda: NOW)

    with pytest.raises(CaptureStructuringTimeoutError):
        adapter.structure(
            RawCaptureV1.model_validate(_raw_payload()),
            deadline=1.0,
            monotonic_clock=lambda: next(ticks),
        )

    assert len(provider.calls) == 1


def test_capture_adapter_reuses_existing_ollama_client_and_model() -> None:
    raw = RawCaptureV1.model_validate(_raw_payload())
    segment = raw.segments[0].model_dump(mode="json", by_alias=True)
    candidate = json.dumps(
        {
            "blocks": [
                {
                    "blockId": f"block-{segment['segmentId']}",
                    "order": segment["order"],
                    "type": "paragraph",
                    "sourceSegmentId": segment["segmentId"],
                    "locator": segment["locator"],
                    "sourceText": segment["text"],
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
    adapter = CertPrepCaptureStructuringAdapter(lazy_provider, clock=lambda: NOW)

    result = CaptureDocumentV1.model_validate(adapter.structure(raw))

    assert factory_calls == 1
    assert result.blocks[0].target_text == "Visible target text"
    assert result.raw_segments == raw.segments
    assert len(ollama_client.chat_calls) == 1
    call = ollama_client.chat_calls[0]
    assert call["model"] == "cert-prep-qwen"
    assert call["think"] is False
    assert call["format"]["title"] == "_CaptureBlockBatchV1"


def test_capture_adapter_has_no_hidden_provider_fallback() -> None:
    class DraftOnlyProvider:
        provider = "fake"
        model = "fake-model"

    adapter = CertPrepCaptureStructuringAdapter(DraftOnlyProvider(), clock=lambda: NOW)

    with pytest.raises(ProviderUnavailableError, match="cannot produce structured JSON"):
        adapter.structure(RawCaptureV1.model_validate(_raw_payload()))


def test_contract_rejects_changed_locator_before_host_consumption() -> None:
    payload = _document_payload()
    payload["blocks"][0]["locator"] = {"kind": "page", "page": 99}

    with pytest.raises(ValidationError, match="locator must equal"):
        CaptureDocumentV1.model_validate(payload)


def test_sidecar_client_handshake_upload_and_raw_keep_token_backend_only() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/v1/health/ready":
            return httpx.Response(200, json=_ready_payload())
        if request.method == "POST" and request.url.path == "/v1/captures":
            body = request.content
            assert b'name="sourceKind"' in body
            assert b"\r\n\r\npdf\r\n" in body
            assert b'name="structuringMode"' in body
            assert b"\r\n\r\nhost\r\n" in body
            assert b"PDF bytes" in body
            return httpx.Response(202, json=_job_payload())
        if request.url.path == "/v1/captures/capture-1/raw":
            return httpx.Response(200, json=_raw_payload())
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    transport_client = httpx.Client(transport=httpx.MockTransport(handler))
    client = CaptureRuntimeClient(
        base_url="http://127.0.0.1:43123",
        bearer_token=TOKEN,
        client=transport_client,
    )

    assert client.handshake().capabilities.structuring_modes[-1].value == "host"
    created = client.create_capture(
        CaptureUpload("sample.pdf", b"PDF bytes", "application/pdf"),
        source_kind=CaptureSourceKind.PDF,
        idempotency_key=IDEMPOTENCY_KEY,
    )
    assert created.stage.value == "awaiting_structuring"
    assert client.get_raw(created.capture_id).diagnostic_only is True

    assert all(request.headers["authorization"] == f"Bearer {TOKEN}" for request in requests)
    assert all(TOKEN not in str(request.url) for request in requests)
    assert TOKEN not in repr(client)


def test_sidecar_client_submits_invalid_candidate_verbatim_for_canonical_failure() -> None:
    candidate = "{not-json"

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/captures/capture-1/structure"
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
        client=httpx.Client(transport=httpx.MockTransport(handler)),
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
    with pytest.raises(ValueError, match="127.0.0.1"):
        CaptureRuntimeClient(base_url=base_url, bearer_token=TOKEN)


def test_sidecar_client_rejects_incompatible_schema() -> None:
    transport = httpx.MockTransport(
        lambda _request: httpx.Response(200, json=_ready_payload(schema_version="2"))
    )
    client = CaptureRuntimeClient(
        base_url="http://127.0.0.1:43123",
        bearer_token=TOKEN,
        client=httpx.Client(transport=transport),
    )

    with pytest.raises(CaptureRuntimeCompatibilityError, match="schema 2"):
        client.handshake()


class RecordingCaptureRuntime:
    def __init__(self, *, initial_job: dict[str, object] | None = None) -> None:
        self.initial_job = CaptureJobV1.model_validate(initial_job or _job_payload())
        self.raw = RawCaptureV1.model_validate(_raw_payload())
        self.document = CaptureDocumentV1.model_validate(_document_payload())
        self.handshakes = 0
        self.commits: list[tuple[str, object, UUID]] = []
        self.cancellations: list[str] = []
        self.failures: list[tuple[str, str, str]] = []
        self.deleted: list[str] = []

    def handshake(self):
        self.handshakes += 1

    def create_capture(self, _upload, *, source_kind, idempotency_key, target_language=None):
        self.create_args = (source_kind, idempotency_key, target_language)
        return self.initial_job

    def get_capture(self, _capture_id):
        return CaptureJobV1.model_validate(_job_payload(status="completed", stage="completed"))

    def get_raw(self, _capture_id):
        return self.raw

    def commit_structure(self, capture_id, candidate, *, idempotency_key):
        self.commits.append((capture_id, candidate, idempotency_key))
        return CaptureJobV1.model_validate(_job_payload(status="completed", stage="completed"))

    def get_result(self, _capture_id):
        return self.document

    def report_structuring_failure(self, capture_id, *, code, message):
        self.failures.append((capture_id, code, message))
        return CaptureJobV1.model_validate(_job_payload(status="failed", stage="failed"))

    def cancel_capture(self, capture_id):
        self.cancellations.append(capture_id)
        return CaptureJobV1.model_validate(_job_payload(status="cancelled", stage="cancelled"))

    def delete_capture(self, capture_id):
        self.deleted.append(capture_id)


class ReconciliationCaptureRuntime(RecordingCaptureRuntime):
    def __init__(
        self,
        *,
        commits: list[CaptureJobV1 | Exception] | None = None,
        failures: list[CaptureJobV1 | Exception] | None = None,
        cancellations: list[CaptureJobV1 | Exception] | None = None,
        reads: list[CaptureJobV1 | Exception] | None = None,
    ) -> None:
        super().__init__()
        self.commit_outcomes = list(commits or [])
        self.failure_outcomes = list(failures or [])
        self.cancellation_outcomes = list(cancellations or [])
        self.read_outcomes = list(reads or [])
        self.capture_reads = 0

    @staticmethod
    def _outcome(outcomes: list[CaptureJobV1 | Exception]) -> CaptureJobV1:
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

    def report_structuring_failure(self, capture_id, *, code, message):
        if not self.failure_outcomes:
            return super().report_structuring_failure(
                capture_id,
                code=code,
                message=message,
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
        self.calls: list[tuple[RawCaptureV1, str | None]] = []

    def structure(
        self,
        raw: RawCaptureV1,
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
        poll_interval_seconds=0.01,
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
    assert runtime.create_args[1] != runtime.commits[0][2]
    assert runtime.deleted == []
    coordinator.delete(result.capture_id)
    assert runtime.deleted == ["capture-1"]


def test_capture_coordinator_reconciles_lost_commit_response() -> None:
    runtime = ReconciliationCaptureRuntime(
        commits=[_lost_response("commit response was lost")],
        reads=[_job(status="completed", stage="completed")],
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
            _job(status="completed", stage="completed"),
        ],
        reads=[_job()],
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
    ("status", "stage", "expected_error"),
    [
        ("failed", "failed", CaptureRuntimeJobError),
        ("cancelled", "cancelled", CaptureRuntimeCanceledError),
    ],
)
def test_capture_coordinator_accepts_confirmed_terminal_commit_reconciliation(
    status: str,
    stage: str,
    expected_error: type[Exception],
) -> None:
    runtime = ReconciliationCaptureRuntime(
        commits=[_lost_response("commit response was lost")],
        reads=[_job(status=status, stage=stage)],
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
        reads=[_job(status="failed", stage="failed")],
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
        cancellations=[_job(status="cancelled", stage="cancelled")],
        reads=[
            _job(),
            _job(status="cancelled", stage="cancelled"),
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
        reads=[_job(), _job()],
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
        initial_job=_job_payload(status="running", stage="extracting")
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
    document = CaptureDocumentV1.model_validate(_document_payload())
    extraction = capture_document_to_pdf_extraction(document)

    assert extraction.page_count == 1
    assert extraction.pages[0].page_number == 1
    assert extraction.pages[0].text == "Visible source text"
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
    segments = capture_document_to_audio_segments(CaptureDocumentV1.model_validate(audio))

    assert segments[0].transcript.start_ms == 125
    assert segments[0].transcript.end_ms == 950
    assert segments[0].target_text == "Visible target text"
