from __future__ import annotations

from collections.abc import Iterator
from fractions import Fraction
from io import BytesIO
from pathlib import Path
from datetime import UTC, datetime
import hashlib

import pytest
import av
from pypdf import PdfReader
from fastapi.testclient import TestClient
from PIL import Image

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.capture_workbench.client import (
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
    RuntimeRequirements,
)
from cert_prep_backend.domains.capture_workbench.host_models import RuntimeReady


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
        self._raw: RawCapture | None = None
        self._result: CaptureDocument | None = None

    def handshake(self) -> RuntimeReady:
        return _test_runtime_ready()

    def get_requirements(self) -> RuntimeRequirements:
        return _test_runtime_requirements("ready")

    def start_capture(
        self,
        upload: CaptureUpload,
        *,
        source_kind: CaptureSourceKind,
        client_request_id: str,
        target_language: str | None = None,
    ) -> CaptureOperation:
        del client_request_id, target_language
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
        self._raw = RawCapture.model_validate(
            {
                "schemaVersion": "2",
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
                    "model": f"capture-runtime@{CAPTURE_RUNTIME_VERSION}",
                    "digest": f"sha256:{'a' * 64}",
                    "device": "test",
                },
                "warnings": [],
                "createdAt": now,
            }
        )
        return self._operation(status="awaiting_structuring")

    def get_partial(self, capture_id: str) -> PartialCapture:
        assert self._raw is not None
        return PartialCapture.model_validate(
            {
                "protocolVersion": "2",
                "captureId": capture_id,
                "source": self._raw.source.model_dump(mode="json", by_alias=True),
                "revision": 1,
                "coveredUntilMs": 0,
                "segments": [
                    segment.model_dump(mode="json", by_alias=True)
                    for segment in self._raw.segments
                ],
                "sourceText": self._raw.source_text,
                "extractionEngine": self._raw.extraction_engine.model_dump(
                    mode="json", by_alias=True
                ),
                "updatedAt": self._raw.created_at,
            }
        )

    def get_raw(self, _capture_id: str) -> RawCapture:
        assert self._raw is not None
        return self._raw

    def commit_structure(
        self,
        _capture_id: str,
        candidate: object,
        *,
        idempotency_key: object,
    ) -> CaptureOperation:
        del idempotency_key
        self._result = CaptureDocument.model_validate_json(candidate) if isinstance(candidate, str) else CaptureDocument.model_validate(candidate)
        return self._operation(status="completed")

    def get_result(self, _capture_id: str) -> CaptureStreamingResult:
        assert self._raw is not None
        assert self._result is not None
        return CaptureStreamingResult(
            operation=self._operation(status="completed"),
            raw=self._raw,
            result=self._result,
        )

    def get_capture(self, _capture_id: str) -> CaptureOperation:
        return self._operation(
            status="completed" if self._result is not None else "awaiting_structuring"
        )

    def report_structuring_failure(self, *_args, **_kwargs) -> None:
        return None

    def cancel_capture(self, *_args, **_kwargs) -> CaptureOperation:
        return self._operation(status="cancelled")

    def delete_capture(self, _capture_id: str) -> None:
        return None

    def _operation(self, *, status: str) -> CaptureOperation:
        assert self._raw is not None
        now = datetime.now(UTC).isoformat()
        return CaptureOperation.model_validate({
            "protocolVersion": "2",
            "captureId": "test-capture",
            "ingestionId": "test-ingestion",
            "kind": "audio" if self._raw.segments[0].locator.kind == "time" else "pdf",
            "status": status,
            "progress": 1 if status in {"completed", "cancelled"} else 0.5,
            "partialRevision": 1,
            "lastEventSequence": 1,
            "source": self._raw.source.model_dump(mode="json", by_alias=True),
            "error": None,
            "createdAt": now,
            "updatedAt": now,
            "completedAt": now if status in {"completed", "cancelled"} else None,
        })


def _test_runtime_ready() -> RuntimeReady:
    return RuntimeReady.model_validate(
        {
            "ready": True,
            "service": "capture-runtime",
            "apiVersion": "2.0",
            "runtimeVersion": CAPTURE_RUNTIME_VERSION,
            "captureDocumentSchemaVersion": "2",
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


def _test_runtime_requirements(status: str) -> RuntimeRequirements:
    return RuntimeRequirements.model_validate(
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
