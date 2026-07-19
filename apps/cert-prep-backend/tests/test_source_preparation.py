from __future__ import annotations

from io import BytesIO
from types import SimpleNamespace

import pytest
from PIL import Image, PngImagePlugin

from cert_prep_contracts.transcription import MAX_AUDIO_DURATION_MS

from cert_prep_backend.api.errors import InvalidSourceError
from cert_prep_backend.domains.source_documents.source_preparation import prepare_source
from conftest import minimal_audio, minimal_image, minimal_pdf


@pytest.mark.parametrize(
    ("filename", "audio_suffix", "canonical_suffix"),
    [
        ("lesson.mp3", ".mp3", ".mp3"),
        ("lesson.wav", ".wav", ".wav"),
        ("lesson.m4a", ".m4a", ".m4a"),
    ],
)
def test_prepare_source_accepts_supported_audio_by_content(
    filename: str,
    audio_suffix: str,
    canonical_suffix: str,
) -> None:
    content = minimal_audio(audio_suffix)
    prepared = prepare_source(
        content,
        max_pdf_pages=10,
        max_image_pixels=100,
        filename=filename,
    )

    assert prepared.raw_bytes == content
    assert prepared.kind == "audio"
    assert prepared.canonical_suffix == canonical_suffix
    assert prepared.page_count == 0
    assert prepared.ocr_image_png is None
    assert prepared.duration_ms is not None
    assert 900 <= prepared.duration_ms <= 1200


@pytest.mark.parametrize("filename", ["lesson.mp3", "lesson.wav", "lesson.m4a"])
def test_prepare_source_rejects_spoofed_audio_content(filename: str) -> None:
    with pytest.raises(InvalidSourceError, match="does not match"):
        prepare_source(
            minimal_pdf("not audio"),
            max_pdf_pages=10,
            max_image_pixels=100,
            filename=filename,
        )


@pytest.mark.parametrize(
    ("filename", "content"),
    [
        ("lesson.mp3", b"ID3\x04\x00\x00" + b"\x00" * 16),
        (
            "lesson.wav",
            b"RIFF" + (32).to_bytes(4, "little") + b"WAVEfmt " + b"\x00" * 24,
        ),
        ("lesson.m4a", b"\x00\x00\x00\x18ftypM4A " + b"\x00" * 12),
    ],
)
def test_prepare_source_rejects_signature_only_corrupt_audio(
    filename: str,
    content: bytes,
) -> None:
    with pytest.raises(InvalidSourceError, match="not a readable"):
        prepare_source(
            content,
            max_pdf_pages=10,
            max_image_pixels=100,
            filename=filename,
        )


def test_prepare_source_rejects_audio_over_ninety_minutes(monkeypatch) -> None:
    content = minimal_audio(".wav")

    class AudioStream:
        type = "audio"
        duration = 90 * 60 + 1
        time_base = 1
        codec_context = SimpleNamespace(name="pcm_s16le")

    class Container:
        streams = [AudioStream()]
        duration = None

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

    monkeypatch.setattr(
        "cert_prep_backend.domains.source_documents.source_preparation.av.open",
        lambda *_args, **_kwargs: Container(),
    )

    with pytest.raises(InvalidSourceError, match="90 minute limit"):
        prepare_source(
            content,
            max_pdf_pages=10,
            max_image_pixels=100,
            filename="lesson.wav",
        )


def _patch_no_pts_audio_frames(monkeypatch, frame_durations_seconds: list[int]) -> None:
    class AudioStream:
        type = "audio"
        duration = None
        time_base = None
        codec_context = SimpleNamespace(name="pcm_s16le")

    class Container:
        streams = [AudioStream()]
        duration = None

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def decode(self, _audio_stream):
            return iter(
                SimpleNamespace(
                    pts=None,
                    time_base=None,
                    sample_rate=1,
                    samples=duration_seconds,
                )
                for duration_seconds in frame_durations_seconds
            )

    monkeypatch.setattr(
        "cert_prep_backend.domains.source_documents.source_preparation.av.open",
        lambda *_args, **_kwargs: Container(),
    )


def _patch_audio_frames(monkeypatch, frames: list[SimpleNamespace]) -> None:
    class AudioStream:
        type = "audio"
        duration = None
        time_base = None
        codec_context = SimpleNamespace(name="pcm_s16le")

    class Container:
        streams = [AudioStream()]
        duration = None

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def decode(self, _audio_stream):
            return iter(frames)

    monkeypatch.setattr(
        "cert_prep_backend.domains.source_documents.source_preparation.av.open",
        lambda *_args, **_kwargs: Container(),
    )


def test_prepare_source_accumulates_no_pts_frame_duration(monkeypatch) -> None:
    content = minimal_audio(".wav")
    _patch_no_pts_audio_frames(monkeypatch, [1, 1, 1])

    prepared = prepare_source(
        content,
        max_pdf_pages=10,
        max_image_pixels=100,
        filename="lesson.wav",
    )

    assert prepared.duration_ms == 3000


def test_prepare_source_counts_leading_no_pts_frames_before_timestamp(monkeypatch) -> None:
    content = minimal_audio(".wav")
    _patch_audio_frames(
        monkeypatch,
        [
            SimpleNamespace(pts=None, time_base=None, sample_rate=1, samples=1),
            SimpleNamespace(pts=0, time_base=1, sample_rate=1, samples=1),
        ],
    )

    prepared = prepare_source(
        content,
        max_pdf_pages=10,
        max_image_pixels=100,
        filename="lesson.wav",
    )

    assert prepared.duration_ms == 2000


def test_prepare_source_counts_no_pts_tail_after_timestamp(monkeypatch) -> None:
    content = minimal_audio(".wav")
    _patch_audio_frames(
        monkeypatch,
        [
            SimpleNamespace(pts=10, time_base=1, sample_rate=1, samples=1),
            SimpleNamespace(pts=None, time_base=None, sample_rate=1, samples=1),
        ],
    )

    prepared = prepare_source(
        content,
        max_pdf_pages=10,
        max_image_pixels=100,
        filename="lesson.wav",
    )

    assert prepared.duration_ms == 12000


def test_prepare_source_accepts_exactly_ninety_minutes_without_pts(monkeypatch) -> None:
    content = minimal_audio(".wav")
    _patch_no_pts_audio_frames(monkeypatch, [1800, 1800, 1800])

    prepared = prepare_source(
        content,
        max_pdf_pages=10,
        max_image_pixels=100,
        filename="lesson.wav",
    )

    assert prepared.duration_ms == MAX_AUDIO_DURATION_MS


def test_prepare_source_rejects_over_ninety_minutes_without_pts(monkeypatch) -> None:
    content = minimal_audio(".wav")
    _patch_no_pts_audio_frames(monkeypatch, [1800, 1800, 1801])

    with pytest.raises(InvalidSourceError, match="90 minute limit"):
        prepare_source(
            content,
            max_pdf_pages=10,
            max_image_pixels=100,
            filename="lesson.wav",
        )


@pytest.mark.parametrize(
    ("image_format", "canonical_suffix"),
    [("PNG", ".png"), ("JPEG", ".jpg"), ("WEBP", ".webp")],
)
def test_prepare_source_accepts_supported_static_images_by_content(
    image_format: str,
    canonical_suffix: str,
) -> None:
    content = minimal_image(image_format)

    prepared = prepare_source(
        content,
        max_pdf_pages=10,
        max_image_pixels=100,
    )

    assert prepared.raw_bytes == content
    assert prepared.kind == "image"
    assert prepared.canonical_suffix == canonical_suffix
    assert prepared.page_count == 1
    assert prepared.ocr_image_png is not None
    with Image.open(BytesIO(prepared.ocr_image_png)) as normalized:
        assert normalized.format == "PNG"
        assert normalized.mode == "RGB"
        assert normalized.size == (8, 6)


def test_png_metadata_containing_pdf_marker_is_still_recognized_as_png() -> None:
    png_info = PngImagePlugin.PngInfo()
    png_info.add_text("source-note", "%PDF- marker in image metadata")
    output = BytesIO()
    Image.new("RGB", (2, 2), "white").save(
        output,
        format="PNG",
        pnginfo=png_info,
    )
    content = output.getvalue()
    assert 0 <= content.find(b"%PDF-") < 1024

    prepared = prepare_source(
        content,
        max_pdf_pages=10,
        max_image_pixels=100,
    )

    assert prepared.kind == "image"
    assert prepared.canonical_suffix == ".png"


def test_prepare_source_preserves_pdf_behavior_and_suffix() -> None:
    content = minimal_pdf("Embedded source text")

    prepared = prepare_source(
        content,
        max_pdf_pages=10,
        max_image_pixels=100,
    )

    assert prepared.raw_bytes == content
    assert prepared.kind == "pdf"
    assert prepared.canonical_suffix == ".pdf"
    assert prepared.page_count == 1
    assert prepared.ocr_image_png is None


def test_prepare_source_applies_exif_orientation() -> None:
    image = Image.new("RGB", (2, 3), "navy")
    exif = Image.Exif()
    exif[274] = 6
    output = BytesIO()
    image.save(output, format="JPEG", exif=exif)

    prepared = prepare_source(
        output.getvalue(),
        max_pdf_pages=10,
        max_image_pixels=100,
    )

    assert prepared.ocr_image_png is not None
    with Image.open(BytesIO(prepared.ocr_image_png)) as normalized:
        assert normalized.size == (3, 2)


def test_prepare_source_flattens_transparency_onto_white() -> None:
    image = Image.new("RGBA", (2, 1), (255, 0, 0, 0))
    image.putpixel((1, 0), (0, 0, 255, 255))
    output = BytesIO()
    image.save(output, format="PNG")

    prepared = prepare_source(
        output.getvalue(),
        max_pdf_pages=10,
        max_image_pixels=100,
    )

    assert prepared.ocr_image_png is not None
    with Image.open(BytesIO(prepared.ocr_image_png)) as normalized:
        assert normalized.mode == "RGB"
        assert normalized.getpixel((0, 0)) == (255, 255, 255)
        assert normalized.getpixel((1, 0)) == (0, 0, 255)


@pytest.mark.parametrize("image_format", ["PNG", "WEBP"])
def test_prepare_source_rejects_animated_supported_images(image_format: str) -> None:
    frames = [Image.new("RGB", (2, 2), color) for color in ("red", "blue")]
    output = BytesIO()
    frames[0].save(
        output,
        format=image_format,
        save_all=True,
        append_images=frames[1:],
        duration=100,
        loop=0,
    )

    with pytest.raises(InvalidSourceError, match="Animated or multi-frame"):
        prepare_source(
            output.getvalue(),
            max_pdf_pages=10,
            max_image_pixels=100,
        )


@pytest.mark.parametrize("image_format", ["BMP", "GIF", "TIFF"])
def test_prepare_source_rejects_decodable_but_unsupported_images(
    image_format: str,
) -> None:
    with pytest.raises(InvalidSourceError, match="Only PDF, PNG, JPEG, and WebP"):
        prepare_source(
            minimal_image(image_format),
            max_pdf_pages=10,
            max_image_pixels=100,
        )


@pytest.mark.parametrize(
    "content",
    [
        b"<svg xmlns='http://www.w3.org/2000/svg'></svg>",
        b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00heicmif1",
        minimal_image("JPEG")[:32],
    ],
)
def test_prepare_source_rejects_unsupported_or_corrupt_content(content: bytes) -> None:
    with pytest.raises(InvalidSourceError, match="not a readable"):
        prepare_source(
            content,
            max_pdf_pages=10,
            max_image_pixels=100,
        )


def test_prepare_source_rejects_empty_content() -> None:
    with pytest.raises(InvalidSourceError, match="Source file is empty"):
        prepare_source(b"", max_pdf_pages=10, max_image_pixels=100)


def test_prepare_source_rejects_images_over_the_configured_pixel_limit() -> None:
    with pytest.raises(InvalidSourceError, match="6 pixels; the limit is 5"):
        prepare_source(
            minimal_image("PNG", size=(3, 2)),
            max_pdf_pages=10,
            max_image_pixels=5,
        )


def test_prepare_source_rejects_pillow_decompression_bombs(monkeypatch) -> None:
    content = minimal_image("PNG", size=(3, 3))
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 4)

    with pytest.raises(InvalidSourceError, match="safe decoding limit"):
        prepare_source(
            content,
            max_pdf_pages=10,
            max_image_pixels=100,
        )
