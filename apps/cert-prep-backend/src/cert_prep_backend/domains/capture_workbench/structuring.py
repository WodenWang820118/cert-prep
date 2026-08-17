"""Cert Prep's authenticated adapter for Capture Runtime pull sessions.

The runtime owns batching, prompt/schema projection, semantic validation, and
provenance reconstruction.  Cert Prep only supplies its configured structured
JSON provider with the typed prompt returned by the authenticated runtime
client, then submits minimal semantic blocks back through that same client.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import UTC, datetime
import hashlib
import json
import re
from time import monotonic
from uuid import UUID, uuid5

from capture_runtime_client import (
    CaptureDocument,
    CaptureEngine,
    OpenStructuringSession,
    RawCapture,
    StructuringBatch,
    StructuringProviderCapability,
    StructuringSemanticBlock,
    StructuringSessionStatus,
    SubmitStructuringBatch,
)

from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.domains.capture_workbench.client import (
    CaptureRuntimeClient,
    CaptureRuntimeProtocolError,
)
from cert_prep_backend.domains.mock_exams.ports import (
    StructuredJsonGenerationProvider,
    provider_capability,
)


_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema"
_PROVIDER_CAPABILITY = "capture-runtime-host-structuring-v2"
_IDEMPOTENCY_NAMESPACE = UUID("b76c9346-c90d-4705-889f-c7a0ae4bf0f2")
_IDENTITY_STRUCTURING_ENGINE = CaptureEngine(
    engine="cert-prep-host",
    model="capture-document-pass-through-v1",
    digest=f"sha256:{hashlib.sha256(b'capture-document-pass-through-v1').hexdigest()}",
)


class CaptureStructuringCanceledError(RuntimeError):
    """Host structuring observed cancellation at a batch boundary."""


class CaptureStructuringTimeoutError(TimeoutError):
    """Host structuring observed its deadline at a batch boundary."""


class CaptureStructuringBudgetError(ValueError):
    """The runtime could not plan one or more provider batches."""


class CertPrepCaptureStructuringAdapter:
    """Run Cert Prep's provider through an authenticated typed pull session."""

    def __init__(
        self,
        provider: object,
        runtime_client: CaptureRuntimeClient | None = None,
        *,
        clock: Callable[[], datetime] | None = None,
        num_ctx: int = 8_192,
        num_predict: int = 4_096,
    ) -> None:
        # These values remain part of the host-facing construction seam for
        # callers that configure provider budgets.  Pull-session planning is
        # intentionally performed by Capture Runtime, so the adapter never
        # recreates or second-guesses its batch planner.
        if num_ctx <= 0 or num_predict <= 0:
            raise ValueError("Capture structuring provider budgets must be positive")
        self._provider = provider
        self._runtime_client = runtime_client
        self._clock = clock or (lambda: datetime.now(UTC))
        self._num_ctx = num_ctx
        self._num_predict = num_predict

    def structure(
        self,
        raw: RawCapture,
        *,
        capture_id: str | None = None,
        operation_id: str | None = None,
        target_language: str | None = None,
        review_overrides: Mapping[str, str] | None = None,
        should_cancel: Callable[[], bool] = lambda: False,
        deadline: float | None = None,
        monotonic_clock: Callable[[], float] = monotonic,
    ) -> CaptureDocument:
        """Generate and submit every runtime-planned semantic batch.

        Only ``providerPrompt`` and ``providerSchema`` cross into the host
        provider.  Provider output is decoded into strict typed semantic DTOs;
        raw segments, locators, source text, and engine provenance never come
        from the provider.
        """

        if self._runtime_client is None:
            raise CaptureRuntimeProtocolError(
                "Capture Runtime pull structuring requires a runtime client."
            )
        if capture_id is None or operation_id is None:
            raise CaptureRuntimeProtocolError(
                "Capture Runtime pull structuring requires capture and operation IDs."
            )
        provider = (
            provider_capability(self._provider, StructuredJsonGenerationProvider)
            if target_language is not None
            else None
        )
        if target_language is not None and provider is None:
            raise ProviderUnavailableError(
                "The configured Cert Prep provider cannot produce structured JSON."
            )
        self._checkpoint(should_cancel, deadline, monotonic_clock)

        engine = _engine_identity(provider) if provider is not None else _IDENTITY_STRUCTURING_ENGINE
        request = OpenStructuringSession(
            capture_id=capture_id,
            target_language=target_language,
            provider_capability=StructuringProviderCapability(
                provider=engine,
                capability=_PROVIDER_CAPABILITY,
                schema_dialect=_SCHEMA_DIALECT,
            ),
            schema_dialect=_SCHEMA_DIALECT,
            client_request_id=operation_id,
        )
        session = self._runtime_client.open_structuring_session(
            capture_id,
            request,
            idempotency_key=operation_id,
        )
        if session.capture_id != capture_id:
            raise ValueError("Capture Runtime structuring session identity does not match capture")

        segments_by_id = {segment.segment_id: segment for segment in raw.segments}
        overrides = dict(review_overrides or {})
        next_batch = session.next_batch_index
        while next_batch < session.batch_count:
            self._checkpoint(should_cancel, deadline, monotonic_clock)
            batch = self._runtime_client.pull_structuring_batch(capture_id, next_batch)
            if batch.capture_id != capture_id or batch.batch_index != next_batch:
                raise ValueError("Capture Runtime returned a mismatched structuring batch")
            semantic = self._semantic_submission(
                batch,
                provider,
                segments_by_id=segments_by_id,
                target_language=target_language,
                review_overrides=overrides,
            )
            self._checkpoint(should_cancel, deadline, monotonic_clock)
            session = self._runtime_client.submit_structuring_batch(
                capture_id,
                next_batch,
                semantic,
                idempotency_key=_batch_idempotency_key(operation_id, next_batch),
            )
            next_batch = session.next_batch_index
            if session.status in {
                StructuringSessionStatus.FAILED,
                StructuringSessionStatus.CANCELLED,
            }:
                raise ValueError("Capture Runtime structuring session did not complete")

        result = self._runtime_client.get_result(capture_id)
        if result.operation.status.value != "completed":
            raise ValueError("Capture Runtime did not attach a completed structuring result")
        return result.result

    def _semantic_submission(
        self,
        batch: StructuringBatch,
        provider: StructuredJsonGenerationProvider | None,
        *,
        segments_by_id: Mapping[str, object],
        target_language: str | None,
        review_overrides: Mapping[str, str],
    ) -> SubmitStructuringBatch:
        if provider is None:
            blocks_value: list[object] = [
                {
                    "sourceSegmentId": segment_id,
                    "type": (
                        "transcript"
                        if getattr(getattr(segments_by_id[segment_id], "locator", None), "kind", None)
                        == "time"
                        else "paragraph"
                    ),
                }
                for segment_id in batch.source_segment_ids
            ]
        else:
            candidate = provider.generate_structured_json(
                messages=_provider_messages(batch.provider_prompt),
                json_schema=batch.provider_schema,
                num_ctx=min(self._num_ctx, batch.num_ctx),
                num_predict=min(self._num_predict, batch.num_predict),
            )
            decoded = _decode_provider_candidate(candidate)
            blocks_value = decoded.get("blocks")
            if not isinstance(blocks_value, list):
                raise ValueError("Capture structuring provider output must contain a blocks array")

        semantic_blocks: list[StructuringSemanticBlock] = []
        for block in blocks_value:
            if not isinstance(block, Mapping):
                raise ValueError("Capture structuring provider blocks must be objects")
            payload = dict(block)
            segment_id = payload.get("sourceSegmentId")
            if not isinstance(segment_id, str) or segment_id not in segments_by_id:
                raise ValueError("Capture structuring provider returned an unknown sourceSegmentId")
            # The runtime enforces target-language semantics.  Review text is
            # an explicit host presentation overlay and is only attached when
            # the typed translated surface accepts targetText.
            if target_language is not None and segment_id in review_overrides:
                payload["targetText"] = review_overrides[segment_id]
            semantic_blocks.append(StructuringSemanticBlock.model_validate(payload, strict=True))

        try:
            return SubmitStructuringBatch(
                batch_digest=batch.batch_digest,
                blocks=semantic_blocks,
            )
        except Exception as error:
            message = str(error)
            if "budget" in message.lower():
                raise CaptureStructuringBudgetError(message) from error
            raise

    @staticmethod
    def _checkpoint(
        should_cancel: Callable[[], bool],
        deadline: float | None,
        monotonic_clock: Callable[[], float],
    ) -> None:
        if should_cancel():
            raise CaptureStructuringCanceledError("Capture structuring was cancelled.")
        if deadline is not None and monotonic_clock() >= deadline:
            raise CaptureStructuringTimeoutError("Capture structuring exceeded its deadline.")


def _decode_provider_candidate(candidate: object) -> dict[str, object]:
    if isinstance(candidate, bytes):
        try:
            value = json.loads(candidate.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("Capture structuring provider output is not valid JSON") from error
    elif isinstance(candidate, str):
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError as error:
            raise ValueError("Capture structuring provider output is not valid JSON") from error
    elif isinstance(candidate, Mapping):
        value = dict(candidate)
    else:
        raise ValueError("Capture structuring provider output must be a JSON object")
    if not isinstance(value, dict):
        raise ValueError("Capture structuring provider output must be a JSON object")
    return {str(key): value for key, value in value.items()}


def _provider_messages(prompt: Mapping[str, object]) -> list[dict[str, str]]:
    return [
        {
            "role": "system",
            "content": "Return only strict JSON matching the supplied semantic schema.",
        },
        {
            "role": "user",
            "content": json.dumps(prompt, ensure_ascii=False, separators=(",", ":")),
        },
    ]


def _engine_identity(provider: StructuredJsonGenerationProvider) -> CaptureEngine:
    digest = None
    selection = getattr(provider, "profile_selection", None)
    candidate_digest = getattr(selection, "modelfile_sha256", None)
    if isinstance(candidate_digest, str) and _SHA256.fullmatch(candidate_digest):
        digest = candidate_digest
    if digest is None:
        identity = f"{provider.provider}:{provider.model}:structured-json-v1"
        digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()
    return CaptureEngine(
        engine=provider.provider,
        model=provider.model,
        digest=f"sha256:{digest}",
    )


def _batch_idempotency_key(operation_id: str, batch_index: int) -> str:
    return str(uuid5(_IDEMPOTENCY_NAMESPACE, f"{operation_id}:structuring-batch:{batch_index}"))


__all__ = [
    "CaptureStructuringBudgetError",
    "CaptureStructuringCanceledError",
    "CaptureStructuringTimeoutError",
    "CertPrepCaptureStructuringAdapter",
]
