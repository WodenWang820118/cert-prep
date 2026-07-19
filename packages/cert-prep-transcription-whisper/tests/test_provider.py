from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from cert_prep_contracts.transcription import TranscriptionCanceledError
from cert_prep_transcription_whisper.provider import WhisperTranscriptionProvider
from cert_prep_transcription_whisper.runtime import WhisperModelRuntime


def test_transcribes_japanese_segments_with_time_ranges(tmp_path: Path) -> None:
    audio = tmp_path / "sample.mp3"
    audio.write_bytes(b"fixture")

    class Model:
        def transcribe(self, *_args, **_kwargs):
            return iter([SimpleNamespace(start=0.25, end=1.5, text=" 日本語 ")]), SimpleNamespace(duration=2)

    provider = WhisperTranscriptionProvider(
        prefer_gpu=False,
        model_factory=lambda *_args, **_kwargs: Model(),
    )
    result = provider.transcribe(str(audio))

    assert result.effective_model == "small"
    assert result.device == "cpu"
    assert result.duration_ms == 2000
    assert result.segments[0].text == "日本語"
    assert (result.segments[0].start_ms, result.segments[0].end_ms) == (250, 1500)


def test_gpu_resource_failure_falls_back_once_to_cpu(tmp_path: Path) -> None:
    audio = tmp_path / "sample.wav"
    audio.write_bytes(b"fixture")
    calls: list[tuple[str, str]] = []

    class Model:
        def __init__(self, name: str, device: str) -> None:
            self.name = name
            self.device = device

        def transcribe(self, *_args, **_kwargs):
            if self.device == "cuda":
                raise RuntimeError("CUDA out of memory")
            return iter([]), SimpleNamespace(duration=1)

    def factory(name: str, *, device: str, compute_type: str):
        calls.append((name, device))
        return Model(name, device)

    result = WhisperTranscriptionProvider(model_factory=factory).transcribe(str(audio))

    assert calls == [("large-v3-turbo", "cuda"), ("small", "cpu")]
    assert result.effective_model == "small"
    assert result.warning is not None


def test_bounds_segments_to_audio_duration_and_drops_out_of_range(
    tmp_path: Path,
) -> None:
    audio = tmp_path / "sample.m4a"
    audio.write_bytes(b"fixture")

    class Model:
        def transcribe(self, *_args, **_kwargs):
            return iter(
                [
                    SimpleNamespace(start=-1.0, end=-0.25, text="before"),
                    SimpleNamespace(start=-0.25, end=0.25, text="opening"),
                    SimpleNamespace(start=0.25, end=1.0, text="middle"),
                    SimpleNamespace(start=1.9, end=2.2, text="ending"),
                    SimpleNamespace(start=2.0, end=2.5, text="after"),
                    SimpleNamespace(start=1.5, end=1.5, text="zero length"),
                    SimpleNamespace(start=1.0, end=1.5, text="   "),
                ]
            ), SimpleNamespace(duration=2.0)

    provider = WhisperTranscriptionProvider(
        prefer_gpu=False,
        model_factory=lambda *_args, **_kwargs: Model(),
    )

    result = provider.transcribe(str(audio))

    assert [segment.text for segment in result.segments] == [
        "opening",
        "middle",
        "ending",
    ]
    assert [
        (segment.start_ms, segment.end_ms) for segment in result.segments
    ] == [
        (0, 250),
        (250, 1000),
        (1900, 2000),
    ]
    assert all(
        0 <= segment.start_ms < segment.end_ms <= result.duration_ms
        for segment in result.segments
    )


def test_non_resource_gpu_failure_does_not_fall_back(tmp_path: Path) -> None:
    audio = tmp_path / "sample.wav"
    audio.write_bytes(b"fixture")
    calls: list[tuple[str, str]] = []

    class Model:
        def transcribe(self, *_args, **_kwargs):
            raise RuntimeError("malformed audio stream")

    def factory(name: str, *, device: str, compute_type: str):
        calls.append((name, device))
        return Model()

    provider = WhisperTranscriptionProvider(model_factory=factory)

    with pytest.raises(RuntimeError, match="malformed audio stream"):
        provider.transcribe(str(audio))

    assert calls == [("large-v3-turbo", "cuda")]


def test_rejects_excessive_duration_before_consuming_segments(tmp_path: Path) -> None:
    audio = tmp_path / "sample.wav"
    audio.write_bytes(b"fixture")
    consumed = False

    def segments():
        nonlocal consumed
        consumed = True
        yield SimpleNamespace(start=0.0, end=1.0, text="too long")

    class Model:
        def transcribe(self, *_args, **_kwargs):
            return segments(), SimpleNamespace(duration=90 * 60 + 1)

    provider = WhisperTranscriptionProvider(
        prefer_gpu=False,
        model_factory=lambda *_args, **_kwargs: Model(),
    )

    with pytest.raises(ValueError, match="90 minute limit"):
        provider.transcribe(str(audio))

    assert consumed is False


def test_rejects_unsupported_audio_suffix(tmp_path: Path) -> None:
    source = tmp_path / "sample.ogg"
    source.write_bytes(b"fixture")
    with pytest.raises(ValueError, match="MP3, WAV, and M4A"):
        WhisperTranscriptionProvider().transcribe(str(source))


def test_emits_segments_incrementally_and_stops_at_cancel_checkpoint(
    tmp_path: Path,
) -> None:
    audio = tmp_path / "sample.wav"
    audio.write_bytes(b"fixture")
    emitted = []
    cancel = False

    class Model:
        def transcribe(self, *_args, **_kwargs):
            return iter(
                [
                    SimpleNamespace(start=0.0, end=0.5, text="first"),
                    SimpleNamespace(start=0.5, end=1.0, text="second"),
                ]
            ), SimpleNamespace(duration=1.0)

    def on_segment(segment) -> None:
        nonlocal cancel
        emitted.append(segment)
        cancel = True

    provider = WhisperTranscriptionProvider(
        prefer_gpu=False,
        model_factory=lambda *_args, **_kwargs: Model(),
    )

    with pytest.raises(TranscriptionCanceledError, match="canceled"):
        provider.transcribe(
            str(audio),
            on_segment=on_segment,
            should_cancel=lambda: cancel,
        )

    assert [segment.text for segment in emitted] == ["first"]


def test_gpu_fallback_resets_emitted_segments_before_cpu_retry(tmp_path: Path) -> None:
    audio = tmp_path / "sample.wav"
    audio.write_bytes(b"fixture")
    callbacks: list[str] = []

    class Model:
        def __init__(self, device: str) -> None:
            self.device = device

        def transcribe(self, *_args, **_kwargs):
            def segments():
                if self.device == "cuda":
                    yield SimpleNamespace(start=0.0, end=0.5, text="gpu partial")
                    raise RuntimeError("CUDA out of memory")
                yield SimpleNamespace(start=0.0, end=1.0, text="cpu complete")

            return segments(), SimpleNamespace(duration=1.0)

    provider = WhisperTranscriptionProvider(
        model_factory=lambda _name, *, device, compute_type: Model(device),
    )

    result = provider.transcribe(
        str(audio),
        on_segment=lambda segment: callbacks.append(segment.text),
        on_segments_reset=lambda: callbacks.clear(),
    )

    assert callbacks == ["cpu complete"]
    assert [segment.text for segment in result.segments] == ["cpu complete"]
    assert result.effective_model == "small"


def test_production_provider_refuses_missing_models_without_implicit_download(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    audio = tmp_path / "sample.mp3"
    audio.write_bytes(b"fixture")
    factory_calls = 0

    def factory(*_args, **_kwargs):
        nonlocal factory_calls
        factory_calls += 1
        raise AssertionError("WhisperModel must not resolve a missing model.")

    def missing_model(model: str) -> str:
        raise FileNotFoundError(model)

    monkeypatch.setattr("faster_whisper.WhisperModel", factory)
    runtime = WhisperModelRuntime(local_model_resolver=missing_model)

    with pytest.raises(FileNotFoundError, match="not cached"):
        WhisperTranscriptionProvider(model_runtime=runtime).transcribe(str(audio))

    assert factory_calls == 0


def test_gpu_fallback_refuses_uncached_small_model_without_downloading(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    audio = tmp_path / "sample.wav"
    audio.write_bytes(b"fixture")
    primary = tmp_path / "large-v3-turbo"
    primary.mkdir()
    calls: list[tuple[str, str]] = []

    def resolve(model: str) -> str:
        if model == "large-v3-turbo":
            return str(primary)
        raise FileNotFoundError(model)

    class Model:
        def transcribe(self, *_args, **_kwargs):
            raise RuntimeError("CUDA out of memory")

    def factory(name: str, *, device: str, compute_type: str):
        calls.append((name, device))
        return Model()

    monkeypatch.setattr("faster_whisper.WhisperModel", factory)
    runtime = WhisperModelRuntime(local_model_resolver=resolve)

    with pytest.raises(FileNotFoundError, match="not cached"):
        WhisperTranscriptionProvider(model_runtime=runtime).transcribe(str(audio))

    assert calls == [(str(primary), "cuda")]
