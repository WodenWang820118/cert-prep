from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event, Lock
from time import monotonic, sleep
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pytest import MonkeyPatch

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from cert_prep_backend.core.exceptions import DocumentProcessingCanceledError
from cert_prep_backend.domains.source_documents import audio
from cert_prep_backend.domains.source_documents import repository as source_documents_repository
from cert_prep_backend.domains.source_documents.document_worker_pool import (
    DocumentWorkerCloseResult,
    DocumentWorkerPool,
    DocumentWorkerPoolSnapshot,
    DocumentWorkItem,
)
from cert_prep_backend.domains.source_documents.audio_transcription_gate import (
    AudioTranscriptionGate,
)
from cert_prep_backend.routers import documents as documents_router
from cert_prep_contracts.transcription import (
    TranscriptSegment,
    TranscriptionCanceledError,
    TranscriptionResult,
)
from cert_prep_transcription_whisper import WhisperModelInventory
from conftest import minimal_audio
from document_test_helpers import _create_project, _wait_for_document_status


class _ReadyWhisperModelRuntime:
    def inventory(self) -> WhisperModelInventory:
        return WhisperModelInventory(
            available=True,
            installed_models=("large-v3-turbo", "small"),
            missing_models=(),
            installed_paths=(),
            bytes=1,
        )


class _ImmediateTranslationClient:
    def chat(self, **_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(message=SimpleNamespace(content="繁體中文翻譯"))

    def generate(self, **_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace()


class _BlockingCountingTranscriber:
    model_runtime = _ReadyWhisperModelRuntime()

    def __init__(
        self,
        call_capacity: int = 4,
        *,
        fail_calls: set[int] | None = None,
        cooperative_cancel: bool = False,
    ) -> None:
        self.started = [Event() for _ in range(call_capacity)]
        self.release = [Event() for _ in range(call_capacity)]
        self.source_paths: list[Path] = []
        self._lock = Lock()
        self._calls = 0
        self._active = 0
        self._max_active = 0
        self._fail_calls = fail_calls or set()
        self._cooperative_cancel = cooperative_cancel

    def transcribe(
        self,
        source_path: str,
        *,
        on_segment=None,
        should_cancel=None,
        on_segments_reset=None,
    ) -> TranscriptionResult:
        del on_segments_reset
        with self._lock:
            call_index = self._calls
            self._calls += 1
            self._active += 1
            self._max_active = max(self._max_active, self._active)
            self.source_paths.append(Path(source_path))
        self.started[call_index].set()
        try:
            if self._cooperative_cancel:
                while not self.release[call_index].wait(timeout=0.01):
                    if should_cancel is not None and should_cancel():
                        raise TranscriptionCanceledError(
                            "Audio transcription was canceled."
                        )
            else:
                assert self.release[call_index].wait(timeout=5)
            if should_cancel is not None and should_cancel():
                raise TranscriptionCanceledError("Audio transcription was canceled.")
            if call_index in self._fail_calls:
                raise RuntimeError("transcription failed")
            segment = TranscriptSegment(
                start_ms=0,
                end_ms=1000,
                text=f"日本語の音声 {call_index + 1}",
            )
            if on_segment is not None:
                on_segment(segment)
            return TranscriptionResult(
                duration_ms=1000,
                segments=(segment,),
                configured_model="large-v3-turbo",
                effective_model="small",
                device="cpu",
            )
        finally:
            with self._lock:
                self._active -= 1

    def counts(self) -> tuple[int, int, int]:
        with self._lock:
            return self._calls, self._active, self._max_active


def test_audio_transcription_gate_releases_slot_after_exception() -> None:
    gate = AudioTranscriptionGate(1)

    with pytest.raises(RuntimeError, match="failed"):
        with gate.acquire():
            raise RuntimeError("transcription failed")

    assert gate.snapshot().active_count == 0
    with gate.acquire():
        assert gate.snapshot().active_count == 1
    assert gate.snapshot().active_count == 0


def test_lifespan_shutdown_cancels_active_and_queued_audio_and_joins_workers(
    tmp_path: Path,
    auth_headers: dict[str, str],
    monkeypatch: MonkeyPatch,
) -> None:
    transcriber = _BlockingCountingTranscriber(cooperative_cancel=True)
    monkeypatch.setattr(audio, "Client", lambda **_kwargs: _ImmediateTranslationClient())
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        transcription_provider=transcriber,
        document_processing_async_jobs=True,
    )

    with TestClient(app) as client:
        project_id = _create_project(client, auth_headers)
        active = _upload_audio(client, auth_headers, project_id, "audio-close-active")
        assert transcriber.started[0].wait(timeout=2)
        queued = _upload_audio(client, auth_headers, project_id, "audio-close-queued")
        _wait_for_pool_counts(app.state.audio_document_worker_pool, running=1, queued=1)
        pool_before_close = app.state.audio_document_worker_pool.snapshot()
        assert pool_before_close.worker_count == 1
        assert pool_before_close.alive_worker_count == 1

    assert source_documents_repository.get_document(
        app.state.database,
        project_id,
        active["id"],
    )["status"] == "canceled"
    assert source_documents_repository.get_document(
        app.state.database,
        project_id,
        queued["id"],
    )["status"] == "canceled"
    pool_after_close = app.state.audio_document_worker_pool.snapshot()
    assert pool_after_close.closed is True
    assert pool_after_close.worker_count == 0
    assert pool_after_close.queued_count == 0
    assert pool_after_close.running_count == 0
    assert pool_after_close.alive_worker_count == 0
    assert app.state.audio_transcription_gate.snapshot().closed is True
    assert transcriber.counts() == (1, 0, 1)
    with pytest.raises(DocumentProcessingCanceledError, match="shutting down"):
        with app.state.audio_transcription_gate.acquire():
            pass


@pytest.mark.parametrize("cancel_by_document", [False, True])
def test_queued_audio_can_be_canceled_immediately_and_pool_continues(
    tmp_path: Path,
    auth_headers: dict[str, str],
    monkeypatch: MonkeyPatch,
    cancel_by_document: bool,
) -> None:
    transcriber = _BlockingCountingTranscriber()
    monkeypatch.setattr(audio, "Client", lambda **_kwargs: _ImmediateTranslationClient())
    app = create_app(
        settings=Settings(
            data_dir=tmp_path,
            api_token="test-token",
            audio_transcription_parallelism=1,
        ),
        transcription_provider=transcriber,
        document_processing_async_jobs=True,
    )

    with TestClient(app) as client:
        project_id = _create_project(client, auth_headers)
        first = _upload_audio(client, auth_headers, project_id, "audio-queue-first")
        assert transcriber.started[0].wait(timeout=2)

        second = _upload_audio(client, auth_headers, project_id, "audio-queue-second")
        _wait_for_pool_counts(app.state.audio_document_worker_pool, running=1, queued=1)
        assert transcriber.counts() == (1, 1, 1)
        queued_operation = client.get(
            f"/projects/{project_id}/document-operations/audio-queue-second",
            headers=auth_headers,
        ).json()
        assert queued_operation["status"] == "running"
        assert queued_operation["phase"] == "processing"
        assert queued_operation["cancellable"] is True

        cancel_path = (
            f"/projects/{project_id}/documents/{second['id']}/processing"
            if cancel_by_document
            else f"/projects/{project_id}/document-operations/audio-queue-second"
        )
        cancel = client.delete(cancel_path, headers=auth_headers)
        assert cancel.status_code == 202
        assert cancel.json()["status"] == "canceled"
        _wait_for_document_status(
            client,
            auth_headers,
            project_id,
            second["id"],
            "canceled",
        )
        _wait_for_pool_counts(app.state.audio_document_worker_pool, running=1, queued=0)
        assert transcriber.counts() == (1, 1, 1)
        assert (
            client.get(
                f"/projects/{project_id}/documents/{second['id']}/chunks",
                headers=auth_headers,
            ).json()["items"]
            == []
        )
        with app.state.database.connect() as connection:
            stored_source = Path(
                connection.execute(
                    "SELECT storage_path FROM documents WHERE id = ?",
                    (second["id"],),
                ).fetchone()[0]
            )
        assert stored_source.is_file()

        third = _upload_audio(client, auth_headers, project_id, "audio-queue-third")
        _wait_for_pool_counts(app.state.audio_document_worker_pool, running=1, queued=1)
        transcriber.release[0].set()
        assert transcriber.started[1].wait(timeout=2)
        assert transcriber.counts() == (2, 1, 1)
        transcriber.release[1].set()

        _wait_for_document_status(
            client,
            auth_headers,
            project_id,
            first["id"],
            "ready",
        )
        _wait_for_document_status(
            client,
            auth_headers,
            project_id,
            third["id"],
            "ready",
        )
        _wait_for_pool_counts(app.state.audio_document_worker_pool, running=0, queued=0)
        _wait_for_gate_counts(app.state.audio_transcription_gate, active=0, waiting=0)
        assert transcriber.counts() == (2, 0, 1)


def test_configured_audio_parallelism_limits_active_provider_calls(
    tmp_path: Path,
    auth_headers: dict[str, str],
    monkeypatch: MonkeyPatch,
) -> None:
    transcriber = _BlockingCountingTranscriber()
    monkeypatch.setattr(audio, "Client", lambda **_kwargs: _ImmediateTranslationClient())
    app = create_app(
        settings=Settings(
            data_dir=tmp_path,
            api_token="test-token",
            audio_transcription_parallelism=2,
        ),
        transcription_provider=transcriber,
        document_processing_async_jobs=True,
    )

    with TestClient(app) as client:
        project_id = _create_project(client, auth_headers)
        documents = [
            _upload_audio(client, auth_headers, project_id, f"audio-parallel-{index}")
            for index in range(3)
        ]
        assert transcriber.started[0].wait(timeout=2)
        assert transcriber.started[1].wait(timeout=2)
        _wait_for_pool_counts(app.state.audio_document_worker_pool, running=2, queued=1)
        gate_snapshot = app.state.audio_transcription_gate.snapshot()
        assert gate_snapshot.active_count == 2
        assert gate_snapshot.waiting_count == 0
        assert app.state.audio_document_worker_pool.snapshot().worker_count == 2
        assert transcriber.counts() == (2, 2, 2)

        transcriber.release[0].set()
        assert transcriber.started[2].wait(timeout=2)
        assert transcriber.counts() == (3, 2, 2)
        transcriber.release[1].set()
        transcriber.release[2].set()

        for document in documents:
            _wait_for_document_status(
                client,
                auth_headers,
                project_id,
                document["id"],
                "ready",
            )
        _wait_for_pool_counts(app.state.audio_document_worker_pool, running=0, queued=0)
        _wait_for_gate_counts(app.state.audio_transcription_gate, active=0, waiting=0)
        assert transcriber.counts() == (3, 0, 2)


def test_queued_audio_reads_verified_canonical_source_after_gate_acquisition(
    tmp_path: Path,
    auth_headers: dict[str, str],
    monkeypatch: MonkeyPatch,
) -> None:
    transcriber = _BlockingCountingTranscriber()
    monkeypatch.setattr(audio, "Client", lambda **_kwargs: _ImmediateTranslationClient())
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        transcription_provider=transcriber,
        document_processing_async_jobs=True,
    )

    with TestClient(app) as client:
        project_id = _create_project(client, auth_headers)
        first = _upload_audio(client, auth_headers, project_id, "audio-source-first")
        assert transcriber.started[0].wait(timeout=2)
        queued = _upload_audio(client, auth_headers, project_id, "audio-source-queued")
        _wait_for_pool_counts(app.state.audio_document_worker_pool, running=1, queued=1)

        with app.state.database.connect() as connection:
            queued_source_path = Path(
                connection.execute(
                    "SELECT storage_path FROM documents WHERE id = ?",
                    (queued["id"],),
                ).fetchone()[0]
            )
        queued_source_path.write_bytes(b"corrupted after queueing")
        transcriber.release[0].set()

        _wait_for_document_status(
            client,
            auth_headers,
            project_id,
            first["id"],
            "ready",
        )
        failed = _wait_for_document_status(
            client,
            auth_headers,
            project_id,
            queued["id"],
            "transcription_failed",
        )
        assert failed["transcription_status"] == "failed"
        assert transcriber.counts() == (1, 0, 1)
        _wait_for_pool_counts(app.state.audio_document_worker_pool, running=0, queued=0)
        _wait_for_gate_counts(app.state.audio_transcription_gate, active=0, waiting=0)


def test_audio_retry_uses_same_transcription_gate(
    tmp_path: Path,
    auth_headers: dict[str, str],
    monkeypatch: MonkeyPatch,
) -> None:
    transcriber = _BlockingCountingTranscriber(fail_calls={0})
    monkeypatch.setattr(audio, "Client", lambda **_kwargs: _ImmediateTranslationClient())
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        transcription_provider=transcriber,
        document_processing_async_jobs=True,
    )

    with TestClient(app) as client:
        project_id = _create_project(client, auth_headers)
        retry_target = _upload_audio(
            client,
            auth_headers,
            project_id,
            "audio-retry-initial",
        )
        assert transcriber.started[0].wait(timeout=2)
        transcriber.release[0].set()
        _wait_for_document_status(
            client,
            auth_headers,
            project_id,
            retry_target["id"],
            "transcription_failed",
        )

        blocker = _upload_audio(client, auth_headers, project_id, "audio-retry-blocker")
        assert transcriber.started[1].wait(timeout=2)
        retried = client.post(
            f"/projects/{project_id}/documents/{retry_target['id']}/retry",
            headers={**auth_headers, "X-Cert-Prep-Operation-Id": "audio-retry-queued"},
        )
        assert retried.status_code == 202
        _wait_for_pool_counts(app.state.audio_document_worker_pool, running=1, queued=1)
        assert transcriber.counts() == (2, 1, 1)
        retry_operation = client.get(
            f"/projects/{project_id}/document-operations/audio-retry-queued",
            headers=auth_headers,
        ).json()
        assert retry_operation["phase"] == "processing"

        transcriber.release[1].set()
        assert transcriber.started[2].wait(timeout=2)
        assert transcriber.counts() == (3, 1, 1)
        transcriber.release[2].set()

        _wait_for_document_status(
            client,
            auth_headers,
            project_id,
            blocker["id"],
            "ready",
        )
        _wait_for_document_status(
            client,
            auth_headers,
            project_id,
            retry_target["id"],
            "ready",
        )
        _wait_for_pool_counts(app.state.audio_document_worker_pool, running=0, queued=0)
        assert transcriber.counts() == (3, 0, 1)


def test_audio_upload_cancel_between_attach_and_submit_is_reconciled(
    tmp_path: Path,
    auth_headers: dict[str, str],
    monkeypatch: MonkeyPatch,
) -> None:
    transcriber = _BlockingCountingTranscriber()
    monkeypatch.setattr(audio, "Client", lambda **_kwargs: _ImmediateTranslationClient())
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        transcription_provider=transcriber,
        document_processing_async_jobs=True,
    )
    controlled_pool = _ControllableSubmitPool(app.state.audio_document_worker_pool)
    app.state.audio_document_worker_pool = controlled_pool

    with TestClient(app) as client:
        project_id = _create_project(client, auth_headers)
        blocker = _upload_audio(client, auth_headers, project_id, "audio-race-blocker")
        assert transcriber.started[0].wait(timeout=2)
        controlled_pool.block_submit("audio-upload-submit-race")

        with ThreadPoolExecutor(max_workers=1) as executor:
            upload = executor.submit(
                _upload_audio,
                client,
                auth_headers,
                project_id,
                "audio-upload-submit-race",
            )
            assert controlled_pool.submit_entered.wait(timeout=2)
            cancel = documents_router.cancel_document_operation(
                project_id,
                "audio-upload-submit-race",
                db=app.state.database,
                audio_workers=controlled_pool,
                ocr_workers=app.state.document_ocr_worker_pool,
            )
            assert cancel["status"] == "cancel_requested"
            controlled_pool.release_submit.set()
            canceled_document = upload.result(timeout=2)

        assert canceled_document["status"] == "canceled"
        operation = client.get(
            f"/projects/{project_id}/document-operations/audio-upload-submit-race",
            headers=auth_headers,
        ).json()
        assert operation["status"] == "canceled"
        assert transcriber.counts() == (1, 1, 1)
        _wait_for_pool_counts(controlled_pool, running=1, queued=0)

        transcriber.release[0].set()
        _wait_for_document_status(
            client,
            auth_headers,
            project_id,
            blocker["id"],
            "ready",
        )


def test_audio_retry_cancel_between_start_and_submit_is_reconciled(
    tmp_path: Path,
    auth_headers: dict[str, str],
    monkeypatch: MonkeyPatch,
) -> None:
    transcriber = _BlockingCountingTranscriber(fail_calls={0})
    monkeypatch.setattr(audio, "Client", lambda **_kwargs: _ImmediateTranslationClient())
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        transcription_provider=transcriber,
        document_processing_async_jobs=True,
    )
    controlled_pool = _ControllableSubmitPool(app.state.audio_document_worker_pool)
    app.state.audio_document_worker_pool = controlled_pool

    with TestClient(app) as client:
        project_id = _create_project(client, auth_headers)
        retry_target = _upload_audio(client, auth_headers, project_id, "audio-race-target")
        assert transcriber.started[0].wait(timeout=2)
        transcriber.release[0].set()
        _wait_for_document_status(
            client,
            auth_headers,
            project_id,
            retry_target["id"],
            "transcription_failed",
        )
        blocker = _upload_audio(client, auth_headers, project_id, "audio-retry-race-blocker")
        assert transcriber.started[1].wait(timeout=2)
        operation_id = "audio-retry-submit-race"
        controlled_pool.block_submit(operation_id)

        with ThreadPoolExecutor(max_workers=1) as executor:
            retry = executor.submit(
                client.post,
                f"/projects/{project_id}/documents/{retry_target['id']}/retry",
                headers={**auth_headers, "X-Cert-Prep-Operation-Id": operation_id},
            )
            assert controlled_pool.submit_entered.wait(timeout=2)
            cancel = documents_router.cancel_document_operation(
                project_id,
                operation_id,
                db=app.state.database,
                audio_workers=controlled_pool,
                ocr_workers=app.state.document_ocr_worker_pool,
            )
            assert cancel["status"] == "cancel_requested"
            controlled_pool.release_submit.set()
            retried = retry.result(timeout=2)

        assert retried.status_code == 202
        assert retried.json()["status"] == "canceled"
        assert transcriber.counts() == (2, 1, 1)
        _wait_for_pool_counts(controlled_pool, running=1, queued=0)

        transcriber.release[1].set()
        _wait_for_document_status(
            client,
            auth_headers,
            project_id,
            blocker["id"],
            "ready",
        )


def test_audio_retry_submit_failure_finishes_operation_durably(
    tmp_path: Path,
    auth_headers: dict[str, str],
    monkeypatch: MonkeyPatch,
) -> None:
    transcriber = _BlockingCountingTranscriber(fail_calls={0})
    monkeypatch.setattr(audio, "Client", lambda **_kwargs: _ImmediateTranslationClient())
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        transcription_provider=transcriber,
        document_processing_async_jobs=True,
    )
    controlled_pool = _ControllableSubmitPool(app.state.audio_document_worker_pool)
    app.state.audio_document_worker_pool = controlled_pool

    with TestClient(app, raise_server_exceptions=False) as client:
        project_id = _create_project(client, auth_headers)
        retry_target = _upload_audio(client, auth_headers, project_id, "audio-submit-target")
        assert transcriber.started[0].wait(timeout=2)
        transcriber.release[0].set()
        _wait_for_document_status(
            client,
            auth_headers,
            project_id,
            retry_target["id"],
            "transcription_failed",
        )
        operation_id = "audio-retry-submit-failure"
        controlled_pool.fail_submit(operation_id)

        retry = client.post(
            f"/projects/{project_id}/documents/{retry_target['id']}/retry",
            headers={**auth_headers, "X-Cert-Prep-Operation-Id": operation_id},
        )

        assert retry.status_code == 500
        operation = client.get(
            f"/projects/{project_id}/document-operations/{operation_id}",
            headers=auth_headers,
        ).json()
        assert operation["status"] == "failed"
        assert operation["error"] == "Document worker could not accept processing."
        failed_document = client.get(
            f"/projects/{project_id}/documents/{retry_target['id']}",
            headers=auth_headers,
        ).json()
        assert failed_document["status"] == "transcription_failed"
        assert transcriber.counts() == (1, 0, 1)


def test_worker_pool_cancel_callback_failure_requeues_for_worker_acknowledgement() -> None:
    pool = DocumentWorkerPool(1, worker_name_prefix="callback-test-worker")
    active_started = Event()
    active_release = Event()
    requeued_ran = Event()

    def run_active() -> None:
        active_started.set()
        assert active_release.wait(timeout=2)

    def fail_cancel() -> None:
        raise RuntimeError("durable callback failed")

    pool.submit(DocumentWorkItem("active", run_active, lambda: None))
    assert active_started.wait(timeout=2)
    pool.submit(DocumentWorkItem("queued", requeued_ran.set, fail_cancel))

    assert pool.cancel("queued") is False
    assert pool.snapshot().queued_count == 1
    active_release.set()
    assert requeued_ran.wait(timeout=2)
    pool.close(join_timeout_seconds=2)
    assert pool.snapshot().alive_worker_count == 0


def test_worker_pool_cancel_failure_racing_close_remains_owned() -> None:
    pool = DocumentWorkerPool(1, worker_name_prefix="cancel-close-race-worker")
    active_started = Event()
    active_release = Event()
    cancel_started = Event()
    cancel_release = Event()
    close_started = Event()
    queued_ran = Event()
    cancel_calls: list[int] = []

    def run_active() -> None:
        active_started.set()
        assert active_release.wait(timeout=2)

    def cancel_queued() -> None:
        cancel_calls.append(len(cancel_calls) + 1)
        if len(cancel_calls) == 1:
            cancel_started.set()
            assert cancel_release.wait(timeout=2)
            raise RuntimeError("transient durable callback failure")

    def close_pool() -> DocumentWorkerCloseResult:
        close_started.set()
        return pool.close(join_timeout_seconds=0)

    pool.submit(DocumentWorkItem("active", run_active, lambda: None))
    assert active_started.wait(timeout=2)
    pool.submit(DocumentWorkItem("queued", queued_ran.set, cancel_queued))

    with ThreadPoolExecutor(max_workers=2) as executor:
        canceled = executor.submit(pool.cancel, "queued")
        assert cancel_started.wait(timeout=2)
        closed = executor.submit(close_pool)
        assert close_started.wait(timeout=2)
        cancel_release.set()

        assert canceled.result(timeout=2) is False
        close_result = closed.result(timeout=2)

    assert close_result.unresolved_count == 0
    assert cancel_calls == [1, 2]
    assert not queued_ran.is_set()
    active_release.set()
    assert pool.close(join_timeout_seconds=2).unresolved_count == 0
    assert pool.snapshot().alive_worker_count == 0


def test_worker_pool_close_retries_unresolved_pending_cancellation() -> None:
    pool = DocumentWorkerPool(1, worker_name_prefix="close-retry-worker")
    active_started = Event()
    active_release = Event()
    queued_ran = Event()
    cancel_calls: list[int] = []

    def run_active() -> None:
        active_started.set()
        assert active_release.wait(timeout=2)

    def cancel_queued() -> None:
        cancel_calls.append(len(cancel_calls) + 1)
        if len(cancel_calls) == 1:
            raise RuntimeError("transient shutdown cancellation failure")

    pool.submit(DocumentWorkItem("active", run_active, lambda: None))
    assert active_started.wait(timeout=2)
    pool.submit(DocumentWorkItem("queued", queued_ran.set, cancel_queued))

    first_close = pool.close(join_timeout_seconds=0)
    assert first_close.unresolved_operation_ids == ("queued",)
    assert cancel_calls == [1]
    assert not queued_ran.is_set()

    second_close = pool.close(join_timeout_seconds=0)
    assert second_close.unresolved_count == 0
    assert cancel_calls == [1, 2]
    assert not queued_ran.is_set()

    active_release.set()
    pool.close(join_timeout_seconds=2)
    assert pool.snapshot().alive_worker_count == 0


def test_persistent_worker_pool_unregisters_workers_after_close() -> None:
    pool = DocumentWorkerPool(2, worker_name_prefix="persistent-test-worker")
    pool.start()

    started = pool.snapshot()
    assert started.worker_count == 2
    assert started.alive_worker_count == 2

    assert pool.close(join_timeout_seconds=2).unresolved_count == 0

    closed = pool.snapshot()
    assert closed.closed is True
    assert closed.worker_count == 0
    assert closed.alive_worker_count == 0


def test_lazy_worker_pool_threads_exit_when_no_lifespan_owner_started_them() -> None:
    pool = DocumentWorkerPool(2, worker_name_prefix="lazy-test-worker")
    completed = Event()

    pool.submit(DocumentWorkItem("lazy", completed.set, lambda: None))

    assert completed.wait(timeout=2)
    deadline = monotonic() + 2
    while pool.snapshot().worker_count > 0 and monotonic() < deadline:
        sleep(0.01)
    snapshot = pool.snapshot()
    assert snapshot.worker_count == 0
    assert snapshot.alive_worker_count == 0


def _upload_audio(
    client: TestClient,
    auth_headers: dict[str, str],
    project_id: str,
    operation_id: str,
) -> dict:
    response = client.post(
        f"/projects/{project_id}/documents",
        headers={**auth_headers, "X-Cert-Prep-Operation-Id": operation_id},
        files={"file": (f"{operation_id}.wav", minimal_audio(".wav"), "audio/wav")},
    )
    assert response.status_code == 201
    return response.json()


class _ControllableSubmitPool:
    def __init__(self, delegate: DocumentWorkerPool) -> None:
        self._delegate = delegate
        self._blocked_operation_id: str | None = None
        self._failed_operation_id: str | None = None
        self.submit_entered = Event()
        self.release_submit = Event()

    def block_submit(self, operation_id: str) -> None:
        self._blocked_operation_id = operation_id
        self.submit_entered.clear()
        self.release_submit.clear()

    def fail_submit(self, operation_id: str) -> None:
        self._failed_operation_id = operation_id

    def start(self) -> None:
        self._delegate.start()

    def submit(self, item: DocumentWorkItem) -> None:
        if item.operation_id == self._failed_operation_id:
            raise RuntimeError("controlled submit failure")
        if item.operation_id == self._blocked_operation_id:
            self.submit_entered.set()
            assert self.release_submit.wait(timeout=5)
        self._delegate.submit(item)

    def cancel(self, operation_id: str) -> bool:
        return self._delegate.cancel(operation_id)

    def close(self, *, join_timeout_seconds: float) -> DocumentWorkerCloseResult:
        return self._delegate.close(join_timeout_seconds=join_timeout_seconds)

    def is_closed(self) -> bool:
        return self._delegate.is_closed()

    def snapshot(self) -> DocumentWorkerPoolSnapshot:
        return self._delegate.snapshot()


def _wait_for_gate_counts(
    gate: AudioTranscriptionGate,
    *,
    active: int,
    waiting: int,
    timeout: float = 2,
) -> None:
    deadline = monotonic() + timeout
    while monotonic() < deadline:
        snapshot = gate.snapshot()
        if snapshot.active_count == active and snapshot.waiting_count == waiting:
            return
        sleep(0.01)
    snapshot = gate.snapshot()
    raise AssertionError(
        "Audio transcription gate did not reach expected counts: "
        f"expected active={active}, waiting={waiting}; "
        f"actual active={snapshot.active_count}, waiting={snapshot.waiting_count}."
    )


def _wait_for_pool_counts(
    pool: DocumentWorkerPool,
    *,
    running: int,
    queued: int,
    timeout: float = 2,
) -> None:
    deadline = monotonic() + timeout
    while monotonic() < deadline:
        snapshot = pool.snapshot()
        if snapshot.running_count == running and snapshot.queued_count == queued:
            return
        sleep(0.01)
    snapshot = pool.snapshot()
    raise AssertionError(
        "Audio document worker pool did not reach expected counts: "
        f"expected running={running}, queued={queued}; "
        f"actual running={snapshot.running_count}, queued={snapshot.queued_count}."
    )
