"""HTTP models shared by the Capture Reviews routes."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from capture_runtime_client import CaptureOperation


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class CaptureReviewOperationRead(CaptureOperation):
    """Host capture operation plus its durable Cert Prep source identity."""

    source_id: str
