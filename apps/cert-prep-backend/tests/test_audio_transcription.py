from __future__ import annotations

from pathlib import Path
from threading import Event, Thread
from types import SimpleNamespace

from fastapi.testclient import TestClient
from pytest import MonkeyPatch

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from cert_prep_backend.core.exceptions import DocumentProcessingCanceledError
from cert_prep_backend.domains.source_documents import audio
from cert_prep_backend.domains.source_documents import operations as document_operations
from cert_prep_backend.routers import documents as documents_router
from cert_prep_contracts.transcription import (
    TranscriptSegment,
    TranscriptionCanceledError,
    TranscriptionResult,
)
from cert_prep_transcription_whisper import WhisperModelInventory
from conftest import AUTH_TOKEN, minimal_audio
from document_test_helpers import _create_project, _wait_for_document_status


class ReadyWhisperModelRuntime:
    def inventory(self) -> WhisperModelInventory:
        return WhisperModelInventory(
            available=True,
            installed_models=("large-v3-turbo", "small"),
            missing_models=(),
            installed_paths=(),
            bytes=1,
        )


class FakeJapaneseTranscriber:
    model_runtime = ReadyWhisperModelRuntime()

    def transcribe(
        self,
        _source_path: str,
        *,
        on_segment=None,
        should_cancel=None,
        on_segments_reset=None,
    ) -> TranscriptionResult:
        del on_segments_reset
        result = TranscriptionResult(
            duration_ms=2500,
            segments=(TranscriptSegment(250, 2250, "日本語の音声です。"),),
            configured_model="large-v3-turbo",
            effective_model="small",
            device="cpu",
            warning="test fallback",
        )
        for segment in result.segments:
            if should_cancel is not None and should_cancel():
                raise TranscriptionCanceledError("Audio transcription was canceled.")
            if on_segment is not None:
                on_segment(segment)
        return result


class MissingModelJapaneseTranscriber(FakeJapaneseTranscriber):
    def __init__(self) -> None:
        self.model_runtime = MissingWhisperModelRuntime()
        self.transcribe_calls = 0

    def transcribe(self, *args, **kwargs) -> TranscriptionResult:
        self.transcribe_calls += 1
        return super().transcribe(*args, **kwargs)


class UnregisteredModelJapaneseTranscriber:
    def __init__(self) -> None:
        self.transcribe_calls = 0

    def transcribe(self, *args, **kwargs) -> TranscriptionResult:
        self.transcribe_calls += 1
        raise AssertionError("transcription must not start without a registered model runtime")


class MissingWhisperModelRuntime:
    def inventory(self) -> WhisperModelInventory:
        return WhisperModelInventory(
            available=False,
            installed_models=(),
            missing_models=("large-v3-turbo", "small"),
            installed_paths=(),
            bytes=None,
        )


class RecordingTranslationClient:
    def __init__(self) -> None:
        self.chat_calls: list[dict[str, object]] = []
        self.generate_calls: list[dict[str, object]] = []

    def chat(self, **kwargs: object) -> SimpleNamespace:
        self.chat_calls.append(kwargs)
        return SimpleNamespace(
            message=SimpleNamespace(content="  在考試開始前，請勿翻開試題本。  ")
        )

    def generate(self, **kwargs: object) -> SimpleNamespace:
        self.generate_calls.append(kwargs)
        return SimpleNamespace()


class FailingTranslationClient(RecordingTranslationClient):
    def chat(self, **kwargs: object) -> SimpleNamespace:
        self.chat_calls.append(kwargs)
        raise RuntimeError("translation unavailable")


class IncrementalBlockingTranscriber:
    model_runtime = ReadyWhisperModelRuntime()

    def __init__(self) -> None:
        self.first_segment_persisted = Event()
        self.release = Event()
        self.temporary_paths: list[Path] = []

    def transcribe(
        self,
        source_path: str,
        *,
        on_segment=None,
        should_cancel=None,
        on_segments_reset=None,
    ) -> TranscriptionResult:
        del on_segments_reset
        self.temporary_paths.append(Path(source_path))
        segments = (
            TranscriptSegment(0, 1000, "最初の文です。"),
            TranscriptSegment(1000, 2000, "次の文です。"),
        )
        if on_segment is not None:
            on_segment(segments[0])
        self.first_segment_persisted.set()
        assert self.release.wait(timeout=5)
        if should_cancel is not None and should_cancel():
            raise TranscriptionCanceledError("Audio transcription was canceled.")
        if on_segment is not None:
            on_segment(segments[1])
        return TranscriptionResult(
            duration_ms=2000,
            segments=segments,
            configured_model="large-v3-turbo",
            effective_model="small",
            device="cpu",
        )


class IncrementalRuntimeErrorTranscriber(IncrementalBlockingTranscriber):
    def transcribe(
        self,
        source_path: str,
        *,
        on_segment=None,
        should_cancel=None,
        on_segments_reset=None,
    ) -> TranscriptionResult:
        del should_cancel, on_segments_reset
        self.temporary_paths.append(Path(source_path))
        first_segment = TranscriptSegment(0, 1000, "最初の文です。")
        if on_segment is not None:
            on_segment(first_segment)
        self.first_segment_persisted.set()
        assert self.release.wait(timeout=5)
        raise RuntimeError("transcription runtime failed after cancellation")


class TwoSegmentTranscriber:
    model_runtime = ReadyWhisperModelRuntime()

    def transcribe(
        self,
        _source_path: str,
        *,
        on_segment=None,
        should_cancel=None,
        on_segments_reset=None,
    ) -> TranscriptionResult:
        del on_segments_reset
        segments = (
            TranscriptSegment(0, 1000, "最初の文です。"),
            TranscriptSegment(1000, 2000, "次の文です。"),
        )
        for segment in segments:
            if should_cancel is not None and should_cancel():
                raise TranscriptionCanceledError("Audio transcription was canceled.")
            if on_segment is not None:
                on_segment(segment)
        return TranscriptionResult(
            duration_ms=2000,
            segments=segments,
            configured_model="large-v3-turbo",
            effective_model="small",
            device="cpu",
        )


class FailOnceIncrementalTranscriber:
    model_runtime = ReadyWhisperModelRuntime()

    def __init__(self) -> None:
        self.calls = 0

    def transcribe(
        self,
        source_path: str,
        *,
        on_segment=None,
        should_cancel=None,
        on_segments_reset=None,
    ) -> TranscriptionResult:
        self.calls += 1
        if self.calls > 1:
            return FakeJapaneseTranscriber().transcribe(
                source_path,
                on_segment=on_segment,
                should_cancel=should_cancel,
                on_segments_reset=on_segments_reset,
            )
        del should_cancel, on_segments_reset
        if on_segment is not None:
            on_segment(TranscriptSegment(0, 1000, "途中までの日本語"))
        raise RuntimeError("transcription runtime failed")


class EmptyThenJapaneseTranscriber:
    model_runtime = ReadyWhisperModelRuntime()

    def __init__(self) -> None:
        self.calls = 0

    def transcribe(
        self,
        source_path: str,
        *,
        on_segment=None,
        should_cancel=None,
        on_segments_reset=None,
    ) -> TranscriptionResult:
        self.calls += 1
        if self.calls > 1:
            return FakeJapaneseTranscriber().transcribe(
                source_path,
                on_segment=on_segment,
                should_cancel=should_cancel,
                on_segments_reset=on_segments_reset,
            )
        del source_path, on_segment, should_cancel, on_segments_reset
        return TranscriptionResult(
            duration_ms=1200,
            segments=(),
            configured_model="large-v3-turbo",
            effective_model="small",
            device="cpu",
        )


class BlockingTranslationClient(RecordingTranslationClient):
    def __init__(self) -> None:
        super().__init__()
        self.started = Event()
        self.release = Event()

    def chat(self, **kwargs: object) -> SimpleNamespace:
        self.chat_calls.append(kwargs)
        self.started.set()
        assert self.release.wait(timeout=5)
        return SimpleNamespace(message=SimpleNamespace(content="翻譯完成"))


class BlockingTranslator:
    def __init__(self) -> None:
        self.started = Event()
        self.release = Event()
        self.inputs: list[str] = []

    def translate(self, japanese: str) -> str:
        self.inputs.append(japanese)
        self.started.set()
        assert self.release.wait(timeout=5)
        return "不得寫入的舊翻譯"


def test_ollama_translation_disables_thinking_and_bounds_generation(
    monkeypatch: MonkeyPatch,
) -> None:
    client = RecordingTranslationClient()

    def make_client(*, host: str, timeout: float) -> RecordingTranslationClient:
        assert host == "http://127.0.0.1:11434"
        assert timeout == 120.0
        return client

    monkeypatch.setattr(audio, "Client", make_client)
    translator = audio.OllamaTraditionalChineseTranslator(Settings())

    translated = translator.translate("試験が始まる前に、問題用紙を開けないでください。")

    assert translated == "在考試開始前，請勿翻開試題本。"
    assert len(client.chat_calls) == 1
    call = client.chat_calls[0]
    assert call["model"] == "qwen3.5:4b"
    assert call["think"] is False
    assert call["stream"] is False
    assert call["keep_alive"] == 0
    assert client.generate_calls == []
    assert call["options"] == {
        "temperature": 0,
        "num_ctx": 2048,
        "num_predict": 512,
    }
    messages = call["messages"]
    assert isinstance(messages, list)
    assert messages[-1] == {
        "role": "user",
        "content": "試験が始まる前に、問題用紙を開けないでください。",
    }


def test_audio_upload_is_rejected_before_storage_when_whisper_models_are_missing(
    tmp_path: Path,
) -> None:
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN)
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
    transcriber = MissingModelJapaneseTranscriber()
    wav = minimal_audio(".wav")

    with TestClient(
        create_app(
            settings=settings,
            transcription_provider=transcriber,
            document_processing_async_jobs=False,
        )
    ) as client:
        project_id = _create_project(client, headers)
        response = client.post(
            f"/projects/{project_id}/documents",
            headers=headers,
            data={"language_hint": "ja"},
            files={"file": ("lesson.wav", wav, "audio/wav")},
        )
        documents = client.get(
            f"/projects/{project_id}/documents",
            headers=headers,
        )

    assert response.status_code == 503
    assert response.json()["code"] == "whisper_models_missing"
    assert transcriber.transcribe_calls == 0
    assert documents.json()["items"] == []


def test_audio_upload_fails_closed_when_whisper_requirement_is_unregistered(
    tmp_path: Path,
) -> None:
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN)
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
    transcriber = UnregisteredModelJapaneseTranscriber()

    with TestClient(
        create_app(
            settings=settings,
            transcription_provider=transcriber,
            document_processing_async_jobs=False,
        )
    ) as client:
        project_id = _create_project(client, headers)
        response = client.post(
            f"/projects/{project_id}/documents",
            headers=headers,
            data={"language_hint": "ja"},
            files={"file": ("lesson.wav", minimal_audio(".wav"), "audio/wav")},
        )
        documents = client.get(
            f"/projects/{project_id}/documents",
            headers=headers,
        )

    assert response.status_code == 503
    assert response.json()["code"] == "whisper_models_missing"
    assert response.json()["details"] == {"missing_requirement": "whisper_models"}
    assert transcriber.transcribe_calls == 0
    assert documents.json()["items"] == []


def test_audio_upload_preserves_transcript_when_translation_is_unavailable(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    translation_client = FailingTranslationClient()

    def make_client(*, host: str, timeout: float) -> FailingTranslationClient:
        assert host == "http://127.0.0.1:1"
        assert timeout == 0.1
        return translation_client

    monkeypatch.setattr(audio, "Client", make_client)
    settings = Settings(
        data_dir=tmp_path,
        api_token=AUTH_TOKEN,
        ollama_host="http://127.0.0.1:1",
        ollama_timeout_seconds=0.1,
    )
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
    wav = minimal_audio(".wav")
    with TestClient(
        create_app(
            settings=settings,
            transcription_provider=FakeJapaneseTranscriber(),
            document_processing_async_jobs=False,
        )
    ) as client:
        project_id = _create_project(client, headers)
        response = client.post(
            f"/projects/{project_id}/documents",
            headers=headers,
            data={"language_hint": "ja"},
            files={"file": ("lesson.wav", wav, "audio/wav")},
        )

        assert response.status_code == 201
        document = response.json()
        assert document["source_kind"] == "audio"
        assert document["status"] == "ready"
        assert document["transcription_status"] == "succeeded"
        assert document["translation_status"] == "failed"
        assert document["effective_transcription_model"] == "small"

        chunk_response = client.get(
            f"/projects/{project_id}/documents/{document['id']}/chunks",
            headers=headers,
        )
        chunk = chunk_response.json()["items"][0]
        assert chunk["locator_kind"] == "time"
        assert (chunk["start_ms"], chunk["end_ms"]) == (250, 2250)
        assert chunk["text"] == "日本語の音声です。"
        assert chunk["translation_stale"] is True

        edited = client.patch(
            f"/projects/{project_id}/documents/{document['id']}/chunks/{chunk['id']}",
            headers=headers,
            json={"text": "編集した日本語です。"},
        )
        assert edited.status_code == 200
        assert edited.json()["source_revision"] == 2
        assert edited.json()["raw_text"] == "日本語の音声です。"
        assert edited.json()["translation_stale"] is True

    assert len(translation_client.chat_calls) == 1
    assert (
        translation_client.chat_calls[0]["keep_alive"]
        == audio.BATCH_TRANSLATION_KEEP_ALIVE
    )
    assert translation_client.generate_calls == [
        {"model": "qwen3.5:4b", "keep_alive": 0}
    ]


def test_failed_initial_translation_recovers_after_successful_batch_retry(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    failing_client = FailingTranslationClient()
    retry_client = RecordingTranslationClient()
    active_client = {"value": failing_client}
    monkeypatch.setattr(audio, "Client", lambda **_kwargs: active_client["value"])
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN)
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}

    with TestClient(
        create_app(
            settings=settings,
            transcription_provider=TwoSegmentTranscriber(),
            document_processing_async_jobs=False,
        )
    ) as client:
        project_id = _create_project(client, headers)
        uploaded = client.post(
            f"/projects/{project_id}/documents",
            headers=headers,
            files={
                "file": ("lesson.wav", minimal_audio(".wav"), "audio/wav")
            },
        )
        assert uploaded.status_code == 201
        document_id = uploaded.json()["id"]
        assert uploaded.json()["translation_status"] == "failed"

        active_client["value"] = retry_client
        retried = client.post(
            f"/projects/{project_id}/documents/{document_id}/translations",
            headers=headers,
        )
        document = client.get(
            f"/projects/{project_id}/documents/{document_id}",
            headers=headers,
        ).json()
        current_chunks = client.get(
            f"/projects/{project_id}/documents/{document_id}/chunks",
            headers=headers,
        ).json()["items"]

        assert retried.status_code == 200
        assert len(retried.json()["items"]) == 2
        assert document["translation_status"] == "succeeded"
        assert all(chunk["translated_text"] for chunk in current_chunks)
        assert all(not chunk["translation_stale"] for chunk in current_chunks)


def test_translation_cas_discards_result_when_japanese_changes_during_provider_call(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        audio,
        "Client",
        lambda **_kwargs: FailingTranslationClient(),
    )
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token=AUTH_TOKEN),
        transcription_provider=FakeJapaneseTranscriber(),
        document_processing_async_jobs=False,
    )
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}

    with TestClient(app) as client:
        project_id = _create_project(client, headers)
        uploaded = client.post(
            f"/projects/{project_id}/documents",
            headers=headers,
            files={
                "file": ("lesson.wav", minimal_audio(".wav"), "audio/wav")
            },
        ).json()
        chunk = client.get(
            f"/projects/{project_id}/documents/{uploaded['id']}/chunks",
            headers=headers,
        ).json()["items"][0]
        translator = BlockingTranslator()
        outcome: dict[str, object] = {}

        def run_translation() -> None:
            try:
                outcome["chunk"] = audio.translate_chunk(
                    app.state.database,
                    translator=translator,
                    project_id=project_id,
                    document_id=uploaded["id"],
                    chunk_id=chunk["id"],
                )
            except BaseException as exc:  # pragma: no cover - asserted below
                outcome["error"] = exc

        worker = Thread(target=run_translation, daemon=True)
        worker.start()
        assert translator.started.wait(timeout=2)
        edited = client.patch(
            f"/projects/{project_id}/documents/{uploaded['id']}/chunks/{chunk['id']}",
            headers=headers,
            json={"text": "翻訳中に編集した日本語です。"},
        )
        assert edited.status_code == 200
        translator.release.set()
        worker.join(timeout=5)

        assert not worker.is_alive()
        assert "error" not in outcome
        current = client.get(
            f"/projects/{project_id}/documents/{uploaded['id']}/chunks",
            headers=headers,
        ).json()["items"][0]
        document = client.get(
            f"/projects/{project_id}/documents/{uploaded['id']}",
            headers=headers,
        ).json()
        assert translator.inputs == ["日本語の音声です。"]
        assert current["text"] == "翻訳中に編集した日本語です。"
        assert current["source_revision"] == 2
        assert current["translated_text"] is None
        assert current["translation_source_revision"] is None
        assert current["translation_stale"] is True
        assert document["translation_status"] == "failed"


def test_automatic_translation_commit_rechecks_operation_after_concurrent_cancel(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        audio,
        "Client",
        lambda **_kwargs: FailingTranslationClient(),
    )
    operation_id = "translation-cas-cancel"
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token=AUTH_TOKEN),
        transcription_provider=FakeJapaneseTranscriber(),
        document_processing_async_jobs=False,
    )
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}

    with TestClient(app) as client:
        project_id = _create_project(client, headers)
        uploaded = client.post(
            f"/projects/{project_id}/documents",
            headers={**headers, "X-Cert-Prep-Operation-Id": operation_id},
            files={
                "file": ("lesson.wav", minimal_audio(".wav"), "audio/wav")
            },
        ).json()
        chunk = client.get(
            f"/projects/{project_id}/documents/{uploaded['id']}/chunks",
            headers=headers,
        ).json()["items"][0]
        with app.state.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                UPDATE document_operations
                SET status = 'running', phase = 'translating', cancellable = 1
                WHERE id = ? AND project_id = ? AND document_id = ?
                """,
                (operation_id, project_id, uploaded["id"]),
            )
            connection.execute(
                """
                UPDATE documents SET status = 'processing', translation_status = 'pending'
                WHERE id = ? AND project_id = ?
                """,
                (uploaded["id"], project_id),
            )

        translator = BlockingTranslator()
        outcome: dict[str, object] = {}

        def run_translation() -> None:
            try:
                audio.translate_chunk(
                    app.state.database,
                    translator=translator,
                    project_id=project_id,
                    document_id=uploaded["id"],
                    chunk_id=chunk["id"],
                    should_cancel=lambda: False,
                    operation_id=operation_id,
                    reconcile_document_status=False,
                )
            except BaseException as exc:
                outcome["error"] = exc

        worker = Thread(target=run_translation, daemon=True)
        worker.start()
        assert translator.started.wait(timeout=2)
        canceled = document_operations.cancel_operation(
            app.state.database,
            project_id=project_id,
            operation_id=operation_id,
        )
        assert canceled["status"] == "cancel_requested"
        translator.release.set()
        worker.join(timeout=5)

        assert not worker.is_alive()
        assert isinstance(outcome.get("error"), DocumentProcessingCanceledError)
        current = client.get(
            f"/projects/{project_id}/documents/{uploaded['id']}/chunks",
            headers=headers,
        ).json()["items"][0]
        assert current["translated_text"] is None
        assert current["translation_source_revision"] is None
        assert current["translation_stale"] is True


def test_corrupt_audio_is_rejected_before_canonical_storage_or_transcription(
    tmp_path: Path,
    auth_headers,
    monkeypatch: MonkeyPatch,
) -> None:
    def forbidden_storage(*_args, **_kwargs):
        raise AssertionError("corrupt audio must not be stored")

    monkeypatch.setattr(documents_router, "store_source_file", forbidden_storage)
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        transcription_provider=FakeJapaneseTranscriber(),
        document_processing_async_jobs=False,
    )
    with TestClient(app) as client:
        project_id = _create_project(client, auth_headers)
        response = client.post(
            f"/projects/{project_id}/documents",
            headers=auth_headers,
            files={
                "file": (
                    "corrupt.wav",
                    b"RIFF" + (32).to_bytes(4, "little") + b"WAVEfmt " + b"\x00" * 24,
                    "audio/wav",
                )
            },
        )

        assert response.status_code == 422
        assert response.json()["code"] == "validation_error"
        documents = client.get(
            f"/projects/{project_id}/documents",
            headers=auth_headers,
        )
        assert documents.json()["items"] == []


def test_audio_source_requires_auth_preserves_project_scope_and_supports_ranges(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    translation_client = FailingTranslationClient()
    monkeypatch.setattr(
        audio,
        "Client",
        lambda **_kwargs: translation_client,
    )
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN)
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
    wav = minimal_audio(".wav")

    with TestClient(
        create_app(
            settings=settings,
            transcription_provider=FakeJapaneseTranscriber(),
            document_processing_async_jobs=False,
        )
    ) as client:
        project_id = _create_project(client, headers)
        other_project_id = _create_project(client, headers)
        uploaded = client.post(
            f"/projects/{project_id}/documents",
            headers=headers,
            data={"language_hint": "ja"},
            files={"file": ("lesson.wav", wav, "audio/wav")},
        )
        assert uploaded.status_code == 201
        document_id = uploaded.json()["id"]
        source_url = f"/projects/{project_id}/documents/{document_id}/source"

        assert client.get(source_url).status_code == 401
        assert (
            client.get(
                f"/projects/{other_project_id}/documents/{document_id}/source",
                headers=headers,
            ).status_code
            == 404
        )

        source = client.get(source_url, headers=headers)
        assert source.status_code == 200
        assert source.content == wav
        assert source.headers["content-type"] == "audio/wav"
        assert source.headers["accept-ranges"] == "bytes"
        assert source.headers["cache-control"] == "private, no-store"
        assert source.headers["content-disposition"].startswith("inline;")

        ranged = client.get(
            source_url,
            headers={**headers, "Range": "bytes=4-11"},
        )
        assert ranged.status_code == 206
        assert ranged.content == wav[4:12]
        assert ranged.headers["content-range"] == f"bytes 4-11/{len(wav)}"

        with client.app.state.database.connect() as connection:
            storage_path = Path(
                connection.execute(
                    "SELECT storage_path FROM documents WHERE id = ?",
                    (document_id,),
                ).fetchone()["storage_path"]
            )
        storage_path.write_bytes(b"RIFF" + b"tampered but still nonempty")
        tampered = client.get(source_url, headers=headers)
        assert tampered.status_code == 409
        assert tampered.json()["code"] == "audio_source_unavailable"


def test_audio_translation_edit_and_retranslation_lifecycle(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    translation_client = RecordingTranslationClient()

    def make_client(*, host: str, timeout: float) -> RecordingTranslationClient:
        assert host == "http://127.0.0.1:11434"
        assert timeout == 120.0
        return translation_client

    monkeypatch.setattr(audio, "Client", make_client)
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN)
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
    wav = minimal_audio(".wav")

    with TestClient(
        create_app(
            settings=settings,
            transcription_provider=FakeJapaneseTranscriber(),
            document_processing_async_jobs=False,
        )
    ) as client:
        project_id = _create_project(client, headers)
        uploaded = client.post(
            f"/projects/{project_id}/documents",
            headers=headers,
            data={"language_hint": "ja"},
            files={"file": ("lesson.wav", wav, "audio/wav")},
        )

        assert uploaded.status_code == 201
        document = uploaded.json()
        assert document["transcription_status"] == "succeeded"
        assert document["translation_status"] == "succeeded"

        chunk = client.get(
            f"/projects/{project_id}/documents/{document['id']}/chunks",
            headers=headers,
        ).json()["items"][0]
        assert chunk["raw_text"] == "日本語の音声です。"
        assert chunk["translated_text"] == "在考試開始前，請勿翻開試題本。"
        assert chunk["translation_stale"] is False
        assert chunk["source_revision"] == 1
        assert chunk["translation_source_revision"] == 1

        edited = client.patch(
            f"/projects/{project_id}/documents/{document['id']}/chunks/{chunk['id']}",
            headers=headers,
            json={"text": "編集した日本語です。"},
        )
        assert edited.status_code == 200
        assert edited.json()["source_revision"] == 2
        assert edited.json()["translated_text"] == chunk["translated_text"]
        assert edited.json()["translation_stale"] is True
        assert client.get(
            f"/projects/{project_id}/documents/{document['id']}",
            headers=headers,
        ).json()["translation_status"] == "failed"

        single = client.post(
            f"/projects/{project_id}/documents/{document['id']}/chunks/{chunk['id']}/translation",
            headers=headers,
        )
        assert single.status_code == 200
        assert single.json()["translation_source_revision"] == 2
        assert single.json()["translation_stale"] is False
        assert client.get(
            f"/projects/{project_id}/documents/{document['id']}",
            headers=headers,
        ).json()["translation_status"] == "succeeded"

        edited_again = client.patch(
            f"/projects/{project_id}/documents/{document['id']}/chunks/{chunk['id']}",
            headers=headers,
            json={"text": "もう一度編集した日本語です。"},
        )
        assert edited_again.json()["translation_stale"] is True
        assert client.get(
            f"/projects/{project_id}/documents/{document['id']}",
            headers=headers,
        ).json()["translation_status"] == "failed"
        batch = client.post(
            f"/projects/{project_id}/documents/{document['id']}/translations",
            headers=headers,
        )
        assert batch.status_code == 200
        assert len(batch.json()["items"]) == 1
        assert batch.json()["items"][0]["translation_source_revision"] == 3
        assert batch.json()["items"][0]["translation_stale"] is False
        assert client.get(
            f"/projects/{project_id}/documents/{document['id']}",
            headers=headers,
        ).json()["translation_status"] == "succeeded"

        draft = client.post(
            f"/projects/{project_id}/question-drafts",
            headers=headers,
            json={
                "question": "音訊內容指出什麼？",
                "choices": ["A", "B", "C", "D"],
                "answer": "A",
                "document_id": document["id"],
                "chunk_id": chunk["id"],
                "source_excerpt": "日本語の音声です。",
            },
        )
        assert draft.status_code == 201
        assert draft.json()["citation_page"] is None
        assert draft.json()["citation_locator_kind"] == "time"
        assert draft.json()["citation_start_ms"] == 250
        assert draft.json()["citation_end_ms"] == 2250

    assert [call["keep_alive"] for call in translation_client.chat_calls] == [
        audio.BATCH_TRANSLATION_KEEP_ALIVE,
        0,
        audio.BATCH_TRANSLATION_KEEP_ALIVE,
    ]
    assert translation_client.generate_calls == [
        {"model": "qwen3.5:4b", "keep_alive": 0},
        {"model": "qwen3.5:4b", "keep_alive": 0},
    ]


def test_uncanceled_transcription_failure_keeps_partial_japanese_and_can_retry(
    tmp_path: Path,
    auth_headers,
    monkeypatch: MonkeyPatch,
) -> None:
    transcriber = FailOnceIncrementalTranscriber()
    translation_client = RecordingTranslationClient()
    monkeypatch.setattr(audio, "Client", lambda **_kwargs: translation_client)
    operation_id = "failed-audio-transcription"
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        transcription_provider=transcriber,
        document_processing_async_jobs=False,
    )

    with TestClient(app) as client:
        project_id = _create_project(client, auth_headers)
        uploaded = client.post(
            f"/projects/{project_id}/documents",
            headers={
                **auth_headers,
                "X-Cert-Prep-Operation-Id": operation_id,
            },
            files={"file": ("lesson.wav", minimal_audio(".wav"), "audio/wav")},
        )

        assert uploaded.status_code == 201
        failed = uploaded.json()
        assert failed["status"] == "transcription_failed"
        assert failed["transcription_status"] == "failed"
        assert failed["translation_status"] == "failed"
        assert failed["has_text"] is True
        assert failed["chunks_count"] == 1
        assert failed["extraction_method"] == "transcription"
        chunks = client.get(
            f"/projects/{project_id}/documents/{failed['id']}/chunks",
            headers=auth_headers,
        ).json()["items"]
        assert [chunk["text"] for chunk in chunks] == ["途中までの日本語"]
        operation = client.get(
            f"/projects/{project_id}/document-operations/{operation_id}",
            headers=auth_headers,
        ).json()
        assert operation["status"] == "failed"

        retried = client.post(
            f"/projects/{project_id}/documents/{failed['id']}/retry",
            headers={
                **auth_headers,
                "X-Cert-Prep-Operation-Id": "retry-failed-audio-transcription",
            },
        )
        assert retried.status_code == 202
        assert retried.json()["status"] == "succeeded"
        ready = client.get(
            f"/projects/{project_id}/documents/{failed['id']}",
            headers=auth_headers,
        ).json()
        assert ready["status"] == "ready"
        assert ready["transcription_status"] == "succeeded"
        assert ready["translation_status"] == "succeeded"
        assert ready["chunks_count"] == 1


def test_no_speech_audio_is_retryable_and_can_later_produce_a_transcript(
    tmp_path: Path,
    auth_headers,
    monkeypatch: MonkeyPatch,
) -> None:
    transcriber = EmptyThenJapaneseTranscriber()
    monkeypatch.setattr(audio, "Client", lambda **_kwargs: RecordingTranslationClient())
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        transcription_provider=transcriber,
        document_processing_async_jobs=False,
    )

    with TestClient(app) as client:
        project_id = _create_project(client, auth_headers)
        uploaded = client.post(
            f"/projects/{project_id}/documents",
            headers=auth_headers,
            files={"file": ("silence.wav", minimal_audio(".wav"), "audio/wav")},
        )

        assert uploaded.status_code == 201
        no_text = uploaded.json()
        assert no_text["status"] == "no_text_detected"
        assert no_text["transcription_status"] == "succeeded"
        assert no_text["translation_status"] == "not_applicable"
        assert no_text["has_text"] is False
        assert no_text["chunks_count"] == 0

        retried = client.post(
            f"/projects/{project_id}/documents/{no_text['id']}/retry",
            headers=auth_headers,
        )
        assert retried.status_code == 202
        assert retried.json()["status"] == "succeeded"
        ready = client.get(
            f"/projects/{project_id}/documents/{no_text['id']}",
            headers=auth_headers,
        ).json()
        assert ready["status"] == "ready"
        assert ready["chunks_count"] == 1


def test_audio_cancel_during_transcription_preserves_incremental_chunks_and_source(
    tmp_path: Path,
    auth_headers,
    monkeypatch: MonkeyPatch,
) -> None:
    transcriber = IncrementalBlockingTranscriber()
    translation_client = RecordingTranslationClient()
    monkeypatch.setattr(
        audio,
        "Client",
        lambda **_kwargs: translation_client,
    )
    operation_id = "cancel-audio-transcription"
    wav = minimal_audio(".wav")
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        transcription_provider=transcriber,
        document_processing_async_jobs=True,
    )

    with TestClient(app) as client:
        project_id = _create_project(client, auth_headers)
        uploaded = client.post(
            f"/projects/{project_id}/documents",
            headers={
                **auth_headers,
                "X-Cert-Prep-Operation-Id": operation_id,
            },
            files={"file": ("lesson.wav", wav, "audio/wav")},
        )
        assert uploaded.status_code == 201
        assert 900 <= uploaded.json()["duration_ms"] <= 1200
        document_id = uploaded.json()["id"]
        assert transcriber.first_segment_persisted.wait(timeout=2)

        incremental = client.get(
            f"/projects/{project_id}/documents/{document_id}/chunks",
            headers=auth_headers,
        ).json()["items"]
        operation = client.get(
            f"/projects/{project_id}/document-operations/{operation_id}",
            headers=auth_headers,
        ).json()
        assert [item["text"] for item in incremental] == ["最初の文です。"]
        assert operation["phase"] == "transcribing"
        assert operation["cancellable"] is True

        requested = client.delete(
            f"/projects/{project_id}/document-operations/{operation_id}",
            headers=auth_headers,
        )
        assert requested.status_code == 202
        assert requested.json()["status"] == "cancel_requested"
        transcriber.release.set()

        canceled = _wait_for_document_status(
            client,
            auth_headers,
            project_id,
            document_id,
            "canceled",
        )
        chunks = client.get(
            f"/projects/{project_id}/documents/{document_id}/chunks",
            headers=auth_headers,
        ).json()["items"]
        assert canceled["has_text"] is True
        assert canceled["chunks_count"] == 1
        assert canceled["transcription_status"] == "canceled"
        assert canceled["translation_status"] == "canceled"
        assert [item["text"] for item in chunks] == ["最初の文です。"]
        assert translation_client.chat_calls == []

        with app.state.database.connect() as connection:
            canonical_path = Path(
                connection.execute(
                    "SELECT storage_path FROM documents WHERE id = ?",
                    (document_id,),
                ).fetchone()[0]
            )
        assert canonical_path.is_file()
        assert all(not path.exists() for path in transcriber.temporary_paths)

        retried = client.post(
            f"/projects/{project_id}/documents/{document_id}/retry",
            headers={
                **auth_headers,
                "X-Cert-Prep-Operation-Id": "retry-audio-transcription",
            },
        )
        assert retried.status_code == 202
        ready = _wait_for_document_status(
            client,
            auth_headers,
            project_id,
            document_id,
            "ready",
        )
        assert ready["chunks_count"] == 2
        assert ready["transcription_status"] == "succeeded"
        assert ready["translation_status"] == "succeeded"
        assert canonical_path.is_file()
        assert all(not path.exists() for path in transcriber.temporary_paths)


def test_audio_cancel_then_provider_runtime_error_preserves_incremental_state(
    tmp_path: Path,
    auth_headers,
    monkeypatch: MonkeyPatch,
) -> None:
    transcriber = IncrementalRuntimeErrorTranscriber()
    translation_client = RecordingTranslationClient()
    monkeypatch.setattr(
        audio,
        "Client",
        lambda **_kwargs: translation_client,
    )
    operation_id = "cancel-audio-runtime-error"
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        transcription_provider=transcriber,
        document_processing_async_jobs=True,
    )

    with TestClient(app) as client:
        project_id = _create_project(client, auth_headers)
        uploaded = client.post(
            f"/projects/{project_id}/documents",
            headers={
                **auth_headers,
                "X-Cert-Prep-Operation-Id": operation_id,
            },
            files={"file": ("lesson.wav", minimal_audio(".wav"), "audio/wav")},
        )
        assert uploaded.status_code == 201
        document_id = uploaded.json()["id"]
        assert transcriber.first_segment_persisted.wait(timeout=2)

        requested = client.delete(
            f"/projects/{project_id}/document-operations/{operation_id}",
            headers=auth_headers,
        )
        assert requested.status_code == 202
        assert requested.json()["status"] == "cancel_requested"
        transcriber.release.set()

        canceled = _wait_for_document_status(
            client,
            auth_headers,
            project_id,
            document_id,
            "canceled",
        )
        operation = client.get(
            f"/projects/{project_id}/document-operations/{operation_id}",
            headers=auth_headers,
        ).json()
        persisted = client.get(
            f"/projects/{project_id}/documents/{document_id}/chunks",
            headers=auth_headers,
        ).json()["items"]

        assert canceled["has_text"] is True
        assert canceled["chunks_count"] == 1
        assert canceled["extraction_method"] == "transcription"
        assert canceled["transcription_status"] == "canceled"
        assert canceled["translation_status"] == "canceled"
        assert [item["text"] for item in persisted] == ["最初の文です。"]
        assert operation["status"] == "canceled"
        assert operation["phase"] == "canceled"
        assert operation["cancellable"] is False
        assert operation["error"] is None
        assert translation_client.chat_calls == []

        with app.state.database.connect() as connection:
            canonical_path = Path(
                connection.execute(
                    "SELECT storage_path FROM documents WHERE id = ?",
                    (document_id,),
                ).fetchone()[0]
            )
        assert canonical_path.is_file()
        assert all(not path.exists() for path in transcriber.temporary_paths)


def test_audio_cancel_during_translation_stops_later_segments_and_unloads_model(
    tmp_path: Path,
    auth_headers,
    monkeypatch: MonkeyPatch,
) -> None:
    translation_client = BlockingTranslationClient()
    monkeypatch.setattr(
        audio,
        "Client",
        lambda **_kwargs: translation_client,
    )
    operation_id = "cancel-audio-translation"
    wav = minimal_audio(".wav")
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        transcription_provider=TwoSegmentTranscriber(),
        document_processing_async_jobs=True,
    )

    with TestClient(app) as client:
        project_id = _create_project(client, auth_headers)
        uploaded = client.post(
            f"/projects/{project_id}/documents",
            headers={
                **auth_headers,
                "X-Cert-Prep-Operation-Id": operation_id,
            },
            files={"file": ("lesson.wav", wav, "audio/wav")},
        )
        assert uploaded.status_code == 201
        document_id = uploaded.json()["id"]
        assert translation_client.started.wait(timeout=2)

        operation = client.get(
            f"/projects/{project_id}/document-operations/{operation_id}",
            headers=auth_headers,
        ).json()
        transcript = client.get(
            f"/projects/{project_id}/documents/{document_id}/chunks",
            headers=auth_headers,
        ).json()["items"]
        assert operation["phase"] == "translating"
        assert len(transcript) == 2
        assert all(item["translated_text"] is None for item in transcript)

        requested = client.delete(
            f"/projects/{project_id}/documents/{document_id}/processing",
            headers=auth_headers,
        )
        assert requested.status_code == 202
        assert requested.json()["status"] == "cancel_requested"
        translation_client.release.set()

        canceled = _wait_for_document_status(
            client,
            auth_headers,
            project_id,
            document_id,
            "canceled",
        )
        chunks = client.get(
            f"/projects/{project_id}/documents/{document_id}/chunks",
            headers=auth_headers,
        ).json()["items"]
        assert canceled["transcription_status"] == "succeeded"
        assert canceled["translation_status"] == "canceled"
        assert canceled["chunks_count"] == 2
        assert len(translation_client.chat_calls) == 1
        assert all(item["translated_text"] is None for item in chunks)
        assert translation_client.generate_calls == [
            {"model": "qwen3.5:4b", "keep_alive": 0}
        ]
