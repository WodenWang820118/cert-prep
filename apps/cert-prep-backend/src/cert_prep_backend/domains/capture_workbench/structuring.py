"""Cert Prep's provider adapter for the Capture Workbench structuring SDK."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import UTC, datetime
import hashlib
import json
import re
from time import monotonic

from capture_structuring import (
    StructuringValidationError,
    assemble_structuring_document,
    build_structuring_batch_prompt,
    plan_structuring_batches,
    structuring_batch_generation_options,
    structuring_batch_schema,
    validate_structuring_batch,
)

from cert_prep_backend.api.errors import ProviderUnavailableError
from capture_runtime_client import (
    CaptureEngine,
    RawCapture,
)
from cert_prep_backend.domains.mock_exams.ports import (
    StructuredJsonGenerationProvider,
    provider_capability,
)


_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_DEFAULT_NUM_CTX = 8_192
_DEFAULT_NUM_PREDICT = 4_096
_CONTEXT_RESERVE_TOKENS = 512
_OUTPUT_RESERVE_TOKENS = 256
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
    """One raw segment cannot fit the configured provider request budget."""


class CertPrepCaptureStructuringAdapter:
    """Adapt Cert Prep's reasoning provider to the shared host SDK."""

    def __init__(
        self,
        provider: object,
        *,
        clock: Callable[[], datetime] | None = None,
        num_ctx: int = _DEFAULT_NUM_CTX,
        num_predict: int = _DEFAULT_NUM_PREDICT,
    ) -> None:
        if num_predict <= _OUTPUT_RESERVE_TOKENS:
            raise ValueError("Capture structuring output budget is too small")
        if num_ctx <= num_predict + _CONTEXT_RESERVE_TOKENS:
            raise ValueError("Capture structuring context budget is too small")
        self._provider = provider
        self._clock = clock or (lambda: datetime.now(UTC))
        self._num_ctx = num_ctx
        self._num_predict = num_predict

    def structure(
        self,
        raw: RawCapture,
        *,
        target_language: str | None = None,
        should_cancel: Callable[[], bool] = lambda: False,
        deadline: float | None = None,
        monotonic_clock: Callable[[], float] = monotonic,
    ) -> dict[str, object]:
        """Run host structuring through the shared SDK and provider registry."""

        self._checkpoint(
            should_cancel=should_cancel,
            deadline=deadline,
            monotonic_clock=monotonic_clock,
        )
        completed_at = self._clock()
        if completed_at.tzinfo is None or completed_at.utcoffset() is None:
            raise ValueError("Capture structuring clock must return a timezone-aware timestamp")

        if target_language is None:
            return self._identity_document(
                raw,
                completed_at=completed_at,
                should_cancel=should_cancel,
                deadline=deadline,
                monotonic_clock=monotonic_clock,
            )

        provider = provider_capability(self._provider, StructuredJsonGenerationProvider)
        if provider is None:
            raise ProviderUnavailableError(
                "The configured Cert Prep provider cannot produce structured JSON."
            )
        engine = _engine_identity(provider)
        schema = structuring_batch_schema(target_language=target_language)
        raw_segments = [segment.model_dump(mode="json", by_alias=True) for segment in raw.segments]
        try:
            plans = plan_structuring_batches(
                raw_segments,
                target_language=target_language,
                num_ctx=self._num_ctx,
                num_predict=self._num_predict,
                schema=schema,
            )
        except StructuringValidationError as error:
            if "budget" in str(error).lower():
                raise CaptureStructuringBudgetError(str(error)) from error
            raise

        blocks: list[dict[str, object]] = []
        order_offset = 0
        for plan in plans:
            self._checkpoint(
                should_cancel=should_cancel,
                deadline=deadline,
                monotonic_clock=monotonic_clock,
            )
            prompt = build_structuring_batch_prompt(
                plan.segments,
                target_language=target_language,
            )
            batch_num_ctx, batch_num_predict = structuring_batch_generation_options(
                plan,
                max_num_ctx=self._num_ctx,
                max_num_predict=self._num_predict,
            )
            candidate = provider.generate_structured_json(
                messages=_provider_messages(prompt),
                json_schema=schema,
                num_ctx=batch_num_ctx,
                num_predict=batch_num_predict,
            )
            self._checkpoint(
                should_cancel=should_cancel,
                deadline=deadline,
                monotonic_clock=monotonic_clock,
            )
            batch_blocks = validate_structuring_batch(
                candidate,
                plan.segments,
                target_language=target_language,
                order_offset=order_offset,
            )
            blocks.extend(batch_blocks)
            order_offset += len(batch_blocks)

        return assemble_structuring_document(
            raw,
            blocks,
            engine_identity=engine,
            completed_at=completed_at,
        )

    def _identity_document(
        self,
        raw: RawCapture,
        *,
        completed_at: datetime,
        should_cancel: Callable[[], bool],
        deadline: float | None,
        monotonic_clock: Callable[[], float],
    ) -> dict[str, object]:
        """Project OCR segments through the SDK without an unnecessary LLM call."""

        blocks: list[dict[str, object]] = []
        for segment in raw.segments:
            self._checkpoint(
                should_cancel=should_cancel,
                deadline=deadline,
                monotonic_clock=monotonic_clock,
            )
            blocks.append(
                {
                    "blockId": f"block-{segment.segment_id}",
                    "order": segment.order,
                    "type": "transcript"
                    if segment.locator.kind == "time"
                    else "paragraph",
                    "sourceSegmentId": segment.segment_id,
                    "locator": segment.locator.model_dump(mode="json", by_alias=True),
                    "sourceText": segment.text,
                    "targetText": segment.text,
                }
            )
        return assemble_structuring_document(
            raw,
            blocks,
            engine_identity=_IDENTITY_STRUCTURING_ENGINE,
            completed_at=completed_at,
        )

    @staticmethod
    def _checkpoint(
        *,
        should_cancel: Callable[[], bool],
        deadline: float | None,
        monotonic_clock: Callable[[], float],
    ) -> None:
        if should_cancel():
            raise CaptureStructuringCanceledError("Capture structuring was cancelled.")
        if deadline is not None and monotonic_clock() >= deadline:
            raise CaptureStructuringTimeoutError("Capture structuring exceeded its deadline.")


def _provider_messages(prompt: Mapping[str, object]) -> list[dict[str, str]]:
    """Translate the SDK prompt envelope into Cert Prep's chat-provider shape."""

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
    """Derive the trusted Cert Prep engine identity from the selected provider."""

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


__all__ = [
    "CaptureStructuringBudgetError",
    "CaptureStructuringCanceledError",
    "CaptureStructuringTimeoutError",
    "CertPrepCaptureStructuringAdapter",
]
