"""Run cert-prep's real host-mode coordinator against a downloaded sidecar."""

from __future__ import annotations

import json
import os
from uuid import uuid4

from cert_prep_backend.domains.capture_workbench.client import CaptureRuntimeClient
from capture_contracts import CaptureSourceKind
from cert_prep_backend.domains.capture_workbench.coordinator import CertPrepCaptureCoordinator
from cert_prep_backend.domains.capture_workbench.structuring import (
    CertPrepCaptureStructuringAdapter,
)


class EchoStructuredProvider:
    provider = "cert-prep-smoke"
    model = "deterministic-host-structurer"

    def generate_structured_json(
        self,
        *,
        messages: list[dict[str, str]],
        json_schema: dict[str, object],
        num_ctx: int,
        num_predict: int,
    ) -> str:
        del json_schema, num_ctx, num_predict
        prompt = json.loads(messages[1]["content"])
        blocks = [
            {
                "blockId": f"block-{segment['segmentId']}",
                "order": segment["order"],
                "type": "paragraph"
                if segment["locator"]["kind"] == "page"
                else "transcript",
                "sourceSegmentId": segment["segmentId"],
                "locator": segment["locator"],
                "sourceText": segment["text"],
                "targetText": segment["text"],
            }
            for segment in prompt["rawSegments"]
        ]
        return json.dumps({"blocks": blocks}, separators=(",", ":"))


def main() -> None:
    base_url = os.environ["CERT_PREP_CAPTURE_RUNTIME_URL"]
    token = os.environ["CERT_PREP_CAPTURE_RUNTIME_TOKEN"]
    client = CaptureRuntimeClient(
        base_url=base_url,
        bearer_token=token,
    )
    try:
        coordinator = CertPrepCaptureCoordinator(
            client=client,
            structurer=CertPrepCaptureStructuringAdapter(EchoStructuredProvider()),
            poll_interval_seconds=0.05,
            timeout_seconds=30,
        )
        source = b"%PDF-1.4\nCAPTURE_TEXT:cert-prep capture-runtime host flow smoke"
        result = coordinator.capture(
            operation_id=str(uuid4()),
            file_name="capture-runtime-smoke.pdf",
            content=source,
            media_type="application/pdf",
            source_kind=CaptureSourceKind.PDF,
            target_language=None,
            should_cancel=lambda: False,
        )
        assert result.raw.source.bytes == len(source)
        assert result.raw.source_text == "cert-prep capture-runtime host flow smoke"
        assert result.document.source == result.raw.source
        assert result.document.raw_segments == result.raw.segments
        assert result.document.blocks[0].target_text == result.raw.segments[0].text
        coordinator.delete(result.capture_id)
    finally:
        client.close()
    print("cert-prep CaptureRuntimeClient/coordinator host flow passed")


if __name__ == "__main__":
    main()
