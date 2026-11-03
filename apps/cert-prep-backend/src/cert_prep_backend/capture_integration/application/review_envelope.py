"""The review a user submits when confirming a capture.

The confirm endpoint reads it from the request and the runtime adapters apply its edits, so it
lives in the application layer, which both the api and the infrastructure layer may import.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class _ReviewModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class CaptureReviewEdit(_ReviewModel):
    """One user-confirmed replacement for an immutable runtime segment."""

    segment_id: str = Field(min_length=1, max_length=128)
    reviewed_text: str = Field(min_length=1, max_length=1_000_000)


class CaptureReview(_ReviewModel):
    """Cert Prep's product review envelope for a v2 capture candidate."""

    review_version: Literal[2] = 2
    edits: list[CaptureReviewEdit] = Field(default_factory=list)


__all__ = ["CaptureReview", "CaptureReviewEdit"]
