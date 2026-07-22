"""Adapter from Cert Prep's provider registry to Capture Runtime host structuring."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
import json
from math import ceil
import re
from time import monotonic

from pydantic import Field

from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.domains.capture_workbench.contracts import (
    CaptureBlockV1,
    CaptureDocumentV1,
    CaptureEngineV1,
    RawCaptureSegmentV1,
    RawCaptureV1,
    StrictWireModel,
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
_ESTIMATED_BYTES_PER_TOKEN = 3
_MIN_REQUEST_TOKENS = 256


class CaptureStructuringCanceledError(RuntimeError):
    """Host structuring observed cancellation at a batch boundary."""


class CaptureStructuringTimeoutError(TimeoutError):
    """Host structuring observed its deadline at a batch boundary."""


class CaptureStructuringBudgetError(ValueError):
    """One raw segment cannot fit the configured provider request budget."""


class _CaptureBlockBatchV1(StrictWireModel):
    blocks: list[CaptureBlockV1] = Field(min_length=1)


_BATCH_SCHEMA = _CaptureBlockBatchV1.model_json_schema(by_alias=True)


@dataclass(frozen=True, slots=True)
class _BatchPlan:
    segments: tuple[RawCaptureSegmentV1, ...]
    input_tokens: int
    output_tokens: int


class CertPrepCaptureStructuringAdapter:
    """Use the existing host provider without owning another Ollama process."""

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
        raw: RawCaptureV1,
        *,
        target_language: str | None = None,
        should_cancel: Callable[[], bool] = lambda: False,
        deadline: float | None = None,
        monotonic_clock: Callable[[], float] = monotonic,
    ) -> dict[str, object]:
        """Strictly validate provider batches and assemble one canonical candidate."""

        self._checkpoint(
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
        completed_at = self._clock()
        if completed_at.tzinfo is None or completed_at.utcoffset() is None:
            raise ValueError("Capture structuring clock must return a timezone-aware timestamp")

        blocks: list[CaptureBlockV1] = []
        plans = _plan_batches(
            raw.segments,
            target_language=target_language,
            num_ctx=self._num_ctx,
            num_predict=self._num_predict,
        )
        for plan in plans:
            self._checkpoint(
                should_cancel=should_cancel,
                deadline=deadline,
                monotonic_clock=monotonic_clock,
            )
            messages = _batch_messages(plan.segments, target_language=target_language)
            batch_num_predict = min(
                self._num_predict,
                max(_MIN_REQUEST_TOKENS, plan.output_tokens + _OUTPUT_RESERVE_TOKENS),
            )
            batch_num_ctx = min(
                self._num_ctx,
                max(
                    _MIN_REQUEST_TOKENS,
                    plan.input_tokens + batch_num_predict + _CONTEXT_RESERVE_TOKENS,
                ),
            )
            candidate = provider.generate_structured_json(
                messages=messages,
                json_schema=_BATCH_SCHEMA,
                num_ctx=batch_num_ctx,
                num_predict=batch_num_predict,
            )
            self._checkpoint(
                should_cancel=should_cancel,
                deadline=deadline,
                monotonic_clock=monotonic_clock,
            )
            blocks.extend(_validated_batch(candidate, plan.segments))

        document = CaptureDocumentV1(
            source=raw.source,
            raw_segments=raw.segments,
            blocks=blocks,
            source_text=raw.source_text,
            target_text="\n".join(block.target_text for block in blocks),
            extraction_engine=raw.extraction_engine,
            structuring_engine=engine,
            warnings=raw.warnings,
            created_at=raw.created_at,
            completed_at=completed_at,
        )
        return document.model_dump(mode="json", by_alias=True)

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


def _plan_batches(
    segments: Sequence[RawCaptureSegmentV1],
    *,
    target_language: str | None,
    num_ctx: int,
    num_predict: int,
) -> list[_BatchPlan]:
    input_limit = num_ctx - num_predict - _CONTEXT_RESERVE_TOKENS
    output_limit = num_predict - _OUTPUT_RESERVE_TOKENS
    empty_messages = _batch_messages((), target_language=target_language)
    fixed_input = _estimated_json_tokens(
        {"messages": empty_messages, "jsonSchema": _BATCH_SCHEMA}
    )
    fixed_output = _estimated_json_tokens({"blocks": []})
    if fixed_input >= input_limit or fixed_output >= output_limit:
        raise CaptureStructuringBudgetError(
            "Capture structuring schema does not fit the configured provider budget."
        )

    plans: list[_BatchPlan] = []
    current: list[RawCaptureSegmentV1] = []
    current_input = fixed_input
    current_output = fixed_output
    for segment in segments:
        segment_input = _estimated_json_tokens(
            segment.model_dump(mode="json", by_alias=True)
        )
        segment_output = _estimated_block_output_tokens(segment)
        next_input = current_input + segment_input
        next_output = current_output + segment_output
        if current and (next_input > input_limit or next_output > output_limit):
            plans.append(_BatchPlan(tuple(current), current_input, current_output))
            current = []
            current_input = fixed_input
            current_output = fixed_output
            next_input = current_input + segment_input
            next_output = current_output + segment_output
        if next_input > input_limit or next_output > output_limit:
            raise CaptureStructuringBudgetError(
                f"Raw segment {segment.segment_id!r} exceeds the provider token budget."
            )
        current.append(segment)
        current_input = next_input
        current_output = next_output

    if current:
        plans.append(_BatchPlan(tuple(current), current_input, current_output))
    return plans


def _batch_messages(
    segments: Sequence[RawCaptureSegmentV1],
    *,
    target_language: str | None,
) -> list[dict[str, str]]:
    prompt = {
        "instruction": (
            "Return exactly one CaptureBlockBatchV1 JSON object with one block for every raw "
            "segment. Preserve sourceSegmentId, global order, locator, and sourceText exactly. "
            "Set blockId to 'block-' plus sourceSegmentId so it remains globally unique. When "
            "targetLanguage is null, copy sourceText to targetText; otherwise translate only "
            "targetText. Do not add, omit, merge, reorder, or split segments. Do not add markdown "
            "or hidden reasoning."
        ),
        "targetLanguage": target_language,
        "rawSegments": [
            segment.model_dump(mode="json", by_alias=True) for segment in segments
        ],
    }
    return [
        {
            "role": "system",
            "content": (
                "Return only strict JSON matching the supplied batch schema. Preserve source "
                "provenance exactly."
            ),
        },
        {
            "role": "user",
            "content": json.dumps(prompt, ensure_ascii=False, separators=(",", ":")),
        },
    ]


def _validated_batch(
    candidate: str,
    segments: Sequence[RawCaptureSegmentV1],
) -> list[CaptureBlockV1]:
    try:
        decoded = json.loads(candidate)
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError("Capture provider batch must be one valid JSON object.") from error
    if not isinstance(decoded, dict):
        raise ValueError("Capture provider batch must be one JSON object.")
    raw_blocks = decoded.get("blocks")
    if not isinstance(raw_blocks, list) or len(raw_blocks) != len(segments):
        raise ValueError("Capture provider batch must cover every supplied segment exactly once.")

    for raw_block, segment in zip(raw_blocks, segments, strict=True):
        if not isinstance(raw_block, dict):
            raise ValueError("Capture provider blocks must be JSON objects.")
        expected_locator = segment.locator.model_dump(mode="json", by_alias=True)
        expected = {
            "blockId": f"block-{segment.segment_id}",
            "order": segment.order,
            "sourceSegmentId": segment.segment_id,
            "locator": expected_locator,
            "sourceText": segment.text,
        }
        for field, value in expected.items():
            if raw_block.get(field) != value:
                raise ValueError(f"Capture provider block changed required field {field}.")

    validated = _CaptureBlockBatchV1.model_validate_json(candidate, strict=True)
    canonical = validated.model_dump(mode="json", by_alias=True)
    if canonical != decoded:
        raise ValueError("Capture provider batch values must already be canonical.")
    return validated.blocks


def _estimated_block_output_tokens(segment: RawCaptureSegmentV1) -> int:
    projected = {
        "blockId": f"block-{segment.segment_id}",
        "order": segment.order,
        "type": "transcript" if segment.locator.kind == "time" else "paragraph",
        "sourceSegmentId": segment.segment_id,
        "locator": segment.locator.model_dump(mode="json", by_alias=True),
        "sourceText": segment.text,
        "targetText": segment.text,
    }
    target_expansion_reserve = ceil(_estimated_text_tokens(segment.text) / 2)
    return _estimated_json_tokens(projected) + target_expansion_reserve


def _estimated_json_tokens(value: object) -> int:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return max(1, ceil(len(encoded) / _ESTIMATED_BYTES_PER_TOKEN))


def _estimated_text_tokens(value: str) -> int:
    return max(1, ceil(len(value.encode("utf-8")) / _ESTIMATED_BYTES_PER_TOKEN))


def _engine_identity(provider: StructuredJsonGenerationProvider) -> CaptureEngineV1:
    digest = None
    selection = getattr(provider, "profile_selection", None)
    candidate_digest = getattr(selection, "modelfile_sha256", None)
    if isinstance(candidate_digest, str) and _SHA256.fullmatch(candidate_digest):
        digest = candidate_digest
    if digest is None:
        identity = f"{provider.provider}:{provider.model}:structured-json-v1"
        digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()
    return CaptureEngineV1(
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
