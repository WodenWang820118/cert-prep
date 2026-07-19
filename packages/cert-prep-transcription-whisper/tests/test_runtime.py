from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from cert_prep_transcription_whisper.runtime import (
    FALLBACK_MODEL,
    PRIMARY_MODEL,
    WhisperModelDownloadCanceled,
    WhisperModelRuntime,
)


def test_inventory_checks_both_models_without_starting_a_download(
    tmp_path: Path,
) -> None:
    primary = _create_model(tmp_path / PRIMARY_MODEL, 7)
    download_calls = 0

    def resolve(model: str) -> str:
        if model == PRIMARY_MODEL:
            return str(primary)
        raise FileNotFoundError(model)

    def download(**_kwargs):
        nonlocal download_calls
        download_calls += 1
        raise AssertionError("Inventory must remain local-only.")

    runtime = WhisperModelRuntime(
        local_model_resolver=resolve,
        snapshot_downloader=download,
    )

    inventory = runtime.inventory()

    assert inventory.available is False
    assert inventory.installed_models == (PRIMARY_MODEL,)
    assert inventory.missing_models == (FALLBACK_MODEL,)
    assert inventory.bytes == 7
    assert download_calls == 0


def test_download_reports_bundle_progress_and_verifies_both_models(
    tmp_path: Path,
) -> None:
    model_paths = {
        PRIMARY_MODEL: tmp_path / PRIMARY_MODEL,
        FALLBACK_MODEL: tmp_path / FALLBACK_MODEL,
    }
    repo_models = {
        "mobiuslabsgmbh/faster-whisper-large-v3-turbo": PRIMARY_MODEL,
        "Systran/faster-whisper-small": FALLBACK_MODEL,
    }

    def resolve(model: str) -> str:
        path = model_paths[model]
        if not path.is_dir():
            raise FileNotFoundError(model)
        return str(path)

    def download(repo_id: str, **kwargs):
        if kwargs.get("dry_run"):
            return [SimpleNamespace(file_size=100, will_download=True)]
        model = repo_models[repo_id]
        _create_model(model_paths[model], 100)
        progress_class = kwargs["tqdm_class"]
        assert list(progress_class(["config", "model"], total=2)) == [
            "config",
            "model",
        ]
        bar = progress_class(desc="Reconstructing (incomplete total...)", total=100)
        bar.update(100)
        return str(model_paths[model])

    runtime = WhisperModelRuntime(
        local_model_resolver=resolve,
        snapshot_downloader=download,
    )
    progress = []

    inventory = runtime.download(progress.append)

    assert inventory.available is True
    assert inventory.installed_models == (PRIMARY_MODEL, FALLBACK_MODEL)
    assert any(item.completed == 200 and item.total == 200 for item in progress)
    assert progress[-1].phase == "verifying"
    assert progress[-1].cancellable is False


def test_download_cancel_stops_at_progress_checkpoint(tmp_path: Path) -> None:
    model_path = tmp_path / PRIMARY_MODEL

    def resolve(_model: str) -> str:
        if not model_path.is_dir():
            raise FileNotFoundError(PRIMARY_MODEL)
        return str(model_path)

    runtime: WhisperModelRuntime

    def download(_repo_id: str, **kwargs):
        if kwargs.get("dry_run"):
            return [SimpleNamespace(file_size=100, will_download=True)]
        progress_class = kwargs["tqdm_class"]
        bar = progress_class(desc="Reconstructing (incomplete total...)", total=100)
        runtime.cancel()
        bar.update(10)
        raise AssertionError("Canceled download continued.")

    runtime = WhisperModelRuntime(
        models=(PRIMARY_MODEL,),
        local_model_resolver=resolve,
        snapshot_downloader=download,
    )

    with pytest.raises(WhisperModelDownloadCanceled):
        runtime.download(lambda _progress: None)


def test_download_restart_after_cancel_resumes_only_missing_models(
    tmp_path: Path,
) -> None:
    model_paths = {
        PRIMARY_MODEL: tmp_path / PRIMARY_MODEL,
        FALLBACK_MODEL: tmp_path / FALLBACK_MODEL,
    }
    repo_models = {
        "mobiuslabsgmbh/faster-whisper-large-v3-turbo": PRIMARY_MODEL,
        "Systran/faster-whisper-small": FALLBACK_MODEL,
    }
    dry_run_models: list[str] = []
    downloaded_models: list[str] = []

    def resolve(model: str) -> str:
        path = model_paths[model]
        if not path.is_dir():
            raise FileNotFoundError(model)
        return str(path)

    runtime: WhisperModelRuntime

    def download(repo_id: str, **kwargs):
        model = repo_models[repo_id]
        if kwargs.get("dry_run"):
            dry_run_models.append(model)
            return [SimpleNamespace(file_size=100, will_download=True)]

        downloaded_models.append(model)
        _create_model(model_paths[model], 100)
        progress_class = kwargs["tqdm_class"]
        bar = progress_class(desc="Reconstructing (incomplete total...)", total=100)
        if downloaded_models == [PRIMARY_MODEL]:
            runtime.cancel()
        bar.update(100)
        return str(model_paths[model])

    runtime = WhisperModelRuntime(
        local_model_resolver=resolve,
        snapshot_downloader=download,
    )

    with pytest.raises(WhisperModelDownloadCanceled):
        runtime.download(lambda _progress: None)

    canceled_inventory = runtime.inventory()
    assert canceled_inventory.installed_models == (PRIMARY_MODEL,)
    assert canceled_inventory.missing_models == (FALLBACK_MODEL,)

    resumed_progress = []
    resumed_inventory = runtime.download(resumed_progress.append)

    assert resumed_inventory.available is True
    assert resumed_inventory.installed_models == (PRIMARY_MODEL, FALLBACK_MODEL)
    assert resumed_inventory.missing_models == ()
    assert dry_run_models == [PRIMARY_MODEL, FALLBACK_MODEL, FALLBACK_MODEL]
    assert downloaded_models == [PRIMARY_MODEL, FALLBACK_MODEL]
    assert resumed_progress[-1].phase == "verifying"


def _create_model(path: Path, size: int) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    (path / "model.bin").write_bytes(b"x" * size)
    return path
