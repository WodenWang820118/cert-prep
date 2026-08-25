from __future__ import annotations

import pytest

from cert_prep_backend.api.errors import InvalidSourceError
from cert_prep_backend.domains.source_documents.source_preparation import prepare_source
from conftest import minimal_audio, minimal_image, minimal_pdf


@pytest.mark.parametrize("suffix", [".mp3", ".wav", ".m4a"])
def test_prepare_source_validates_supported_audio_envelope(suffix: str) -> None:
    prepared = prepare_source(minimal_audio(suffix), max_pdf_pages=10, max_image_pixels=100, filename=f"lesson{suffix}")
    assert prepared.kind == "audio"
    assert prepared.canonical_suffix == suffix
    assert prepared.duration_ms is not None


def test_prepare_source_rejects_audio_signature_spoof() -> None:
    with pytest.raises(InvalidSourceError):
        prepare_source(minimal_pdf("not audio"), max_pdf_pages=10, max_image_pixels=100, filename="lesson.wav")


@pytest.mark.parametrize("image_format", ["PNG", "JPEG", "WEBP"])
def test_prepare_source_accepts_static_images(image_format: str) -> None:
    prepared = prepare_source(minimal_image(image_format), max_pdf_pages=10, max_image_pixels=100)
    assert prepared.kind == "image"
    assert prepared.page_count == 1


def test_prepare_source_rejects_animated_images() -> None:
    from io import BytesIO
    from PIL import Image

    output = BytesIO()
    frames = [Image.new("RGB", (2, 2), color) for color in ("red", "blue")]
    frames[0].save(output, format="PNG", save_all=True, append_images=frames[1:])
    with pytest.raises(InvalidSourceError, match="Animated"):
        prepare_source(output.getvalue(), max_pdf_pages=10, max_image_pixels=100)


def test_prepare_source_validates_pdf_page_count() -> None:
    prepared = prepare_source(minimal_pdf("source"), max_pdf_pages=10, max_image_pixels=100)
    assert prepared.kind == "pdf"
    assert prepared.page_count == 1


def test_prepare_source_rejects_pdf_page_limit() -> None:
    with pytest.raises(InvalidSourceError, match="pages"):
        prepare_source(minimal_pdf("one", "two"), max_pdf_pages=1, max_image_pixels=100)
