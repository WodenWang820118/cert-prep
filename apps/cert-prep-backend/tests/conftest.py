from __future__ import annotations

from collections.abc import Iterator
from fractions import Fraction
from io import BytesIO
from pathlib import Path
from datetime import UTC, datetime
import hashlib
from uuid import UUID

import pytest
import av
from pypdf import PdfReader
from fastapi.testclient import TestClient
from PIL import Image

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.capture_workbench.client import CaptureUpload
from capture_contracts import (
    CaptureDocumentV1,
    CaptureJobV1,
    CaptureSourceKind,
    RawCaptureV1,
    RuntimeRequirementsV1,
)
from cert_prep_backend.domains.capture_workbench.host_models import RuntimeReadyV1


AUTH_TOKEN = "test-token"


@pytest.fixture
def auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {AUTH_TOKEN}"}


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    with TestClient(
        create_app(
            settings=settings,
            capture_runtime_client=TestCaptureRuntimeClient(),
            document_processing_async_jobs=False,
        )
    ) as test_client:
        yield test_client


class TestCaptureRuntimeClient:
    __test__ = False
    """Deterministic test-side stand-in for the published Capture Runtime HTTP client."""

    def __init__(self) -> None:
        self._raw: RawCaptureV1 | None = None
        self._result: CaptureDocumentV1 | None = None

    def handshake(self) -> RuntimeReadyV1:
        return _test_runtime_ready()

    def get_requirements(self) -> RuntimeRequirementsV1:
        return _test_runtime_requirements("ready")

    def create_capture(self, upload: CaptureUpload, *, source_kind: CaptureSourceKind, idempotency_key: UUID, target_language: str | None = None) -> CaptureJobV1:
        is_audio = source_kind is CaptureSourceKind.AUDIO
        source_pages = _fake_source_pages(upload.content, source_kind)
        source_text = "\n".join(source_pages)
        segments = [
            {
                "segmentId": f"page-{index}",
                "order": index - 1,
                "locator": {"kind": "page", "page": index},
                "text": page_text,
            }
            for index, page_text in enumerate(source_pages, start=1)
        ]
        now = datetime.now(UTC).isoformat()
        self._raw = RawCaptureV1.model_validate(
            {
                "schemaVersion": "1",
                "diagnosticOnly": True,
                "source": {
                    "sha256": hashlib.sha256(upload.content).hexdigest(),
                    "fileName": upload.file_name,
                    "mediaType": upload.media_type,
                    "bytes": len(upload.content),
                },
                "segments": segments,
                "sourceText": source_text,
                "extractionEngine": {
                    "engine": "capture-runtime-whisper" if is_audio else "capture-runtime-windowsml",
                    "model": "capture-runtime@0.3.10",
                    "digest": f"sha256:{'a' * 64}",
                    "device": "test",
                },
                "warnings": [],
                "createdAt": now,
            }
        )
        return self._job(status="running", stage="awaiting_structuring")

    def get_raw(self, _capture_id: str) -> RawCaptureV1:
        assert self._raw is not None
        return self._raw

    def commit_structure(self, _capture_id: str, candidate: object, *, idempotency_key: UUID) -> CaptureJobV1:
        self._result = CaptureDocumentV1.model_validate_json(candidate) if isinstance(candidate, str) else CaptureDocumentV1.model_validate(candidate)
        return self._job(status="completed", stage="completed")

    def get_result(self, _capture_id: str) -> CaptureDocumentV1:
        assert self._result is not None
        return self._result

    def get_capture(self, _capture_id: str) -> CaptureJobV1:
        return self._job(status="running", stage="awaiting_structuring")

    def report_structuring_failure(self, *_args, **_kwargs) -> None:
        return None

    def cancel_capture(self, *_args, **_kwargs) -> CaptureJobV1:
        return self._job(status="cancelled", stage="cancelled")

    def delete_capture(self, _capture_id: str) -> None:
        return None

    def _job(self, *, status: str, stage: str) -> CaptureJobV1:
        assert self._raw is not None
        now = datetime.now(UTC).isoformat()
        return CaptureJobV1.model_validate({
            "captureId": "test-capture",
            "status": status,
            "stage": stage,
            "structuringMode": "host",
            "progress": 1 if status == "completed" else 0.5,
            "source": self._raw.source.model_dump(mode="json", by_alias=True),
            "error": None,
            "createdAt": now,
            "updatedAt": now,
            "completedAt": now if status in {"completed", "cancelled"} else None,
        })


def _test_runtime_ready() -> RuntimeReadyV1:
    return RuntimeReadyV1.model_validate(
        {
            "ready": True,
            "service": "capture-runtime",
            "apiVersion": "1.0",
            "runtimeVersion": "0.3.10",
            "captureDocumentSchemaVersion": "1",
            "capabilities": {
                "captureKinds": ["pdf", "image", "audio"],
                "structuringModes": ["runtime", "host"],
                "supportsCancellation": True,
                "supportsRawDiagnostics": True,
                "maxUploadBytes": 50 * 1024 * 1024,
            },
            "message": None,
        }
    )


def _test_runtime_requirements(status: str) -> RuntimeRequirementsV1:
    return RuntimeRequirementsV1.model_validate(
        {
            "items": [
                {
                    "requirementId": "windowsml-ocr",
                    "kind": "ocr",
                    "displayName": "WindowsML OCR",
                    "status": status,
                    "requiredFor": ["pdf", "image"],
                    "installStrategy": "test",
                },
                {
                    "requirementId": "whisper-primary",
                    "kind": "speech-to-text",
                    "displayName": "Whisper",
                    "status": status,
                    "requiredFor": ["audio"],
                    "installStrategy": "test",
                },
            ]
        }
    )


def minimal_pdf(*page_texts: str) -> bytes:
    objects: dict[int, bytes] = {}
    page_ids: list[int] = []
    next_id = 4

    objects[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[3] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"

    for page_text in page_texts:
        page_id = next_id
        content_id = next_id + 1
        next_id += 2
        page_ids.append(page_id)
        content = _pdf_page_stream(page_text)
        objects[page_id] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>"
        ).encode()
        objects[content_id] = (
            f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream"
        )

    kids = " ".join(f"{page_id} 0 R" for page_id in page_ids)
    objects[2] = f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>".encode()

    output = bytearray(b"%PDF-1.4\n")
    offsets = {0: 0}
    for object_id in sorted(objects):
        offsets[object_id] = len(output)
        output.extend(f"{object_id} 0 obj\n".encode())
        output.extend(objects[object_id])
        output.extend(b"\nendobj\n")

    xref_offset = len(output)
    max_id = max(objects)
    output.extend(f"xref\n0 {max_id + 1}\n".encode())
    output.extend(b"0000000000 65535 f \n")
    for object_id in range(1, max_id + 1):
        output.extend(f"{offsets[object_id]:010d} 00000 n \n".encode())
    output.extend(
        f"trailer << /Root 1 0 R /Size {max_id + 1} >>\n"
        f"startxref\n{xref_offset}\n%%EOF\n".encode()
    )
    return bytes(output)


def _fake_source_pages(content: bytes, source_kind: CaptureSourceKind) -> list[str]:
    if source_kind is CaptureSourceKind.PDF:
        reader = PdfReader(BytesIO(content))
        return [(page.extract_text() or "").strip() for page in reader.pages]
    if source_kind is CaptureSourceKind.AUDIO:
        return ["Captured source text"]
    return ["Captured source text"]


def minimal_image(
    image_format: str = "PNG",
    *,
    size: tuple[int, int] = (8, 6),
    color: tuple[int, int, int] = (20, 40, 60),
) -> bytes:
    output = BytesIO()
    Image.new("RGB", size, color).save(output, format=image_format)
    return output.getvalue()


def minimal_audio(suffix: str = ".wav") -> bytes:
    """Create one second of decodable mono silence in a supported container."""

    output = BytesIO()
    container_format, codec = {
        ".mp3": ("mp3", "mp3"),
        ".wav": ("wav", "pcm_s16le"),
        ".m4a": ("mp4", "aac"),
    }[suffix]
    with av.open(output, mode="w", format=container_format) as container:
        stream = container.add_stream(codec, rate=16_000)
        stream.layout = "mono"
        frame = av.AudioFrame(format="s16", layout="mono", samples=16_000)
        frame.sample_rate = 16_000
        frame.time_base = Fraction(1, 16_000)
        frame.pts = 0
        frame.planes[0].update(bytes(frame.planes[0].buffer_size))
        for packet in stream.encode(frame):
            container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)
    return output.getvalue()


def _pdf_page_stream(text: str) -> bytes:
    if not text:
        return b"q 1 1 1 rg 0 0 1 1 re f Q"
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    return f"BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET".encode()
