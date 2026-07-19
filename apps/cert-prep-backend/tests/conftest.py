from __future__ import annotations

from collections.abc import Iterator
from fractions import Fraction
from io import BytesIO
from pathlib import Path

import pytest
import av
from fastapi.testclient import TestClient
from PIL import Image

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings


AUTH_TOKEN = "test-token"


@pytest.fixture
def auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {AUTH_TOKEN}"}


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    with TestClient(
        create_app(settings=settings, document_processing_async_jobs=False)
    ) as test_client:
        yield test_client


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
