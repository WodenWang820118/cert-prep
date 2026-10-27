"""A recording's stored source can be played only while it is present and unchanged."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.platform.config import Settings
from conftest import AUTH_TOKEN, minimal_audio
from document_test_helpers import _create_project
from test_capture_workbench_pipeline import DeterministicAudioCaptureRuntime, EchoCaptureProvider

HEADERS = {"Authorization": f"Bearer {AUTH_TOKEN}"}


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    app = create_app(
        settings=Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake"),
        llm_provider=EchoCaptureProvider(),
        capture_runtime_client=DeterministicAudioCaptureRuntime(),
        document_processing_async_jobs=False,
        streaming_draft_generation_async_jobs=False,
    )
    with TestClient(app) as test_client:
        yield test_client


def _upload_recording(client: TestClient, tmp_path: Path) -> tuple[str, Path]:
    project_id = _create_project(client, HEADERS)
    uploaded = client.post(
        f"/projects/{project_id}/documents",
        headers=HEADERS,
        files={"file": ("lecture.wav", minimal_audio(".wav"), "audio/wav")},
        data={"language_hint": "ja"},
    )
    assert uploaded.status_code == 201, uploaded.text
    (stored,) = (tmp_path / "uploads" / project_id).iterdir()
    return f"/projects/{project_id}/documents/{uploaded.json()['id']}/source", stored


def test_a_stored_recording_plays_inline(client: TestClient, tmp_path: Path) -> None:
    source_url, stored = _upload_recording(client, tmp_path)

    played = client.get(source_url, headers=HEADERS)

    assert played.status_code == 200
    assert played.headers["content-type"] == "audio/wav"
    assert played.headers["content-disposition"].startswith("inline")
    assert played.content == stored.read_bytes()


def test_a_recording_whose_file_is_gone_is_unavailable(client: TestClient, tmp_path: Path) -> None:
    source_url, stored = _upload_recording(client, tmp_path)
    stored.unlink()

    played = client.get(source_url, headers=HEADERS)

    assert played.status_code == 409
    assert played.json() == {
        "code": "audio_source_unavailable",
        "message": "The stored audio source is unavailable.",
    }


def test_a_recording_whose_file_changed_is_unavailable(client: TestClient, tmp_path: Path) -> None:
    source_url, stored = _upload_recording(client, tmp_path)
    stored.write_bytes(stored.read_bytes() + b"\0")

    played = client.get(source_url, headers=HEADERS)

    assert played.status_code == 409
    assert played.json()["code"] == "audio_source_unavailable"
    assert played.json()["message"] == "The stored audio source failed integrity verification."
