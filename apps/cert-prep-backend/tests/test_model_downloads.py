from threading import Event

from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import DEFAULT_OLLAMA_MODEL, Settings
from cert_prep_backend.domains.mock_exams import ollama_profiles as ollama_profile_module
from cert_prep_ollama.profiles import DEFAULT_PROFILE_ID
from llm_test_fakes import (
    BlockingDownloadProvider,
    FailingDownloadProvider,
    FakeProfileInstaller,
    GIB,
    RecordingDownloadProvider,
    _profile_inventory,
)


AUTH_HEADERS = {"Authorization": "Bearer test-token"}


def test_model_download_installs_selected_ollama_profile(
    monkeypatch,
    tmp_path,
) -> None:
    inventory = _profile_inventory(total_ram=16 * GIB, free_disk=64 * GIB)
    install_events: list[tuple[object, ...]] = []
    monkeypatch.setattr(
        ollama_profile_module,
        "collect_machine_inventory",
        lambda **_kwargs: inventory,
    )

    from cert_prep_ollama import profile_installer as profile_installer_module

    monkeypatch.setattr(
        profile_installer_module,
        "OllamaProfileInstaller",
        lambda profile, **kwargs: FakeProfileInstaller(
            profile,
            install_events,
            fallback_profiles=kwargs.get("fallback_profiles", ()),
        ),
    )
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                llm_provider="ollama",
            ),
            runtime_installation_async_jobs=False,
        )
    )

    response = client.post("/llm/model-downloads", headers=AUTH_HEADERS)

    assert response.status_code == 202
    assert response.json()["model"] == "cert-prep-qwen3.5-4b-study-8k"
    assert response.json()["status"] == "succeeded"
    assert install_events == [
        ("init", DEFAULT_PROFILE_ID, ("qwen3.5-2b-study-4k",)),
        (
            "install",
            "cert-prep-qwen3.5-4b-study-8k",
            ("cert-prep-qwen3.5-2b-study-4k",),
        ),
    ]

def test_model_download_starts_only_from_explicit_post(tmp_path) -> None:
    provider = RecordingDownloadProvider(available=False, detail="model not found")
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            llm_provider=provider,
            runtime_installation_async_jobs=False,
        )
    )

    response = client.post("/llm/model-downloads", headers=AUTH_HEADERS)

    assert response.status_code == 202
    assert provider.pull_calls == 1
    assert response.json() == {
        "id": response.json()["id"],
        "provider": "ollama",
        "model": DEFAULT_OLLAMA_MODEL,
        "status": "succeeded",
        "detail": "model download complete",
        "completed": 100,
        "total": 100,
        "created_at": response.json()["created_at"],
        "updated_at": response.json()["updated_at"],
        "error": None,
    }

def test_model_download_installs_raw_model_when_profile_disabled(tmp_path) -> None:
    provider = RecordingDownloadProvider(available=False, detail="model not found")
    provider.model = "raw-local:latest"
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                llm_provider="ollama",
                ollama_profile_enabled=False,
                ollama_model="raw-local:latest",
            ),
            llm_provider=provider,
            runtime_installation_async_jobs=False,
        )
    )

    response = client.post("/llm/model-downloads", headers=AUTH_HEADERS)

    assert response.status_code == 202
    assert provider.pull_calls == 1
    assert response.json()["model"] == "raw-local:latest"
    assert response.json()["status"] == "succeeded"

def test_model_download_poll_returns_job_status(tmp_path) -> None:
    provider = RecordingDownloadProvider(available=False, detail="model not found")
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            llm_provider=provider,
            runtime_installation_async_jobs=False,
        )
    )
    started = client.post("/llm/model-downloads", headers=AUTH_HEADERS).json()

    response = client.get(f"/llm/model-downloads/{started['id']}", headers=AUTH_HEADERS)

    assert response.status_code == 200
    assert response.json()["id"] == started["id"]
    assert response.json()["status"] == "succeeded"

def test_model_download_reuses_existing_running_job(tmp_path) -> None:
    release_pull = Event()
    provider = BlockingDownloadProvider(release_pull)
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            llm_provider=provider,
        )
    )

    first = client.post("/llm/model-downloads", headers=AUTH_HEADERS)
    second = client.post("/llm/model-downloads", headers=AUTH_HEADERS)
    release_pull.set()

    assert first.status_code == 202
    assert second.status_code == 202
    assert second.json()["id"] == first.json()["id"]
    assert provider.pull_calls == 1

def test_model_download_records_provider_failure(tmp_path) -> None:
    provider = FailingDownloadProvider()
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            llm_provider=provider,
            runtime_installation_async_jobs=False,
        )
    )

    response = client.post("/llm/model-downloads", headers=AUTH_HEADERS)

    assert response.status_code == 202
    assert response.json()["status"] == "failed"
    assert response.json()["detail"] == "Ollama unavailable: connection refused"

def test_model_download_rejects_provider_without_pull_support(client, auth_headers) -> None:
    response = client.post("/llm/model-downloads", headers=auth_headers)

    assert response.status_code == 503
    assert response.json() == {
        "code": "provider_unavailable",
        "message": "Configured LLM provider does not support model downloads.",
    }
