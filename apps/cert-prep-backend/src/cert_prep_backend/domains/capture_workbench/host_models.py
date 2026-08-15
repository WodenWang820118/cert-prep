"""Host-owned DTOs layered over the published Capture Runtime v2 SDK."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from capture_runtime_client import RuntimeReady


class _HostModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class CaptureReviewEdit(_HostModel):
    """One user-confirmed replacement for an immutable runtime segment."""

    segment_id: str = Field(min_length=1, max_length=128)
    reviewed_text: str = Field(min_length=1, max_length=1_000_000)


class CaptureReview(_HostModel):
    """Cert Prep's product review envelope for a v2 capture candidate."""

    review_version: Literal[2] = 2
    edits: list[CaptureReviewEdit] = Field(default_factory=list)


__all__ = ["CaptureReview", "CaptureReviewEdit", "RuntimeReady"]
