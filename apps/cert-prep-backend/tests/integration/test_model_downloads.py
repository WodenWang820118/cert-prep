from threading import Event
from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace

from fastapi.testclient import TestClient

from cert_prep_backend.bootstrap.app import create_app
from cert_prep_backend.platform.config import DEFAULT_OLLAMA_MODEL, Settings
from cert_prep_backend.ai_providers.infrastructure import machine_inventory as machine_inventory_module
from cert_prep_ollama.profiles import DEFAULT_PROFILE_ID
from cert_prep_backend.llm_provisioning.application import use_cases as llm_installations
from cert_prep_backend.llm_provisioning.application.ports import LLMInstallation
from cert_prep_backend.llm_provisioning.domain.installation import (
    LLMInstallationJob,
    LLMInstallationTarget,
)
from cert_prep_backend.llm_provisioning.infrastructure.repository import (
    LLMInstallationJobRepository,
)
from cert_prep_backend.llm_provisioning.infrastructure.manager import ThreadLLMInstallationWork
from cert_prep_contracts.llm_installation import LLMRequirementKind, LLMRequirementSnapshot
from llm_test_fakes import (
    BlockingDownloadProvider,
    FailingDownloadProvider,
    FakeProfileInstaller,
    GIB,
    RecordingDownloadProvider,
    RecordingOnboardingProvider,
    _profile_inventory,
)


AUTH_HEADERS = {"Authorization": "Bearer test-token"}


class RecordingSelectedModelInstallers:
    def __init__(self) -> None:
        self.start_calls = 0

    @property
    def selected_model_kind(self):
        self.start_calls += 1
        return LLMRequirementKind.OLLAMA

    def get(self, kind):
        assert kind == LLMRequirementKind.OLLAMA
        return SimpleNamespace(
            kind=kind, provider="future-provider", model="future-model",
            requirement=lambda: LLMRequirementSnapshot(
                kind=kind, label="selected model", available=False, detail="missing",
                unavailable_reason="model_missing",
            ),
        )

    def ordered(self):
        return [self.get(LLMRequirementKind.OLLAMA)]


def test_model_download_uses_the_selected_model_installer(tmp_path) -> None:
    catalog = RecordingSelectedModelInstallers()
    jobs = LLMInstallationJobRepository()
    jobs.add(replace(LLMInstallationJob.queue(
        id="selected-model-job",
        target=LLMInstallationTarget(LLMRequirementKind.OLLAMA, "future-provider", "future-model"),
        detail="selected model installation queued", total=None,
        now=datetime(2026, 7, 12, tzinfo=UTC),
    ), completed=0))
    work = ThreadLLMInstallationWork(jobs.lock, async_jobs=False)
    runtime = LLMInstallation(jobs, catalog, work, work.clock, work.new_id)
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                llm_provider="fake",
            ),
            llm_installation=runtime,
        )
    )

    response = client.post("/llm/installations", headers=AUTH_HEADERS, json={"kind": "ollama_model"})

    assert response.status_code == 202
    assert response.json()["provider"] == "future-provider"
    assert catalog.start_calls == 1


def test_model_download_installs_selected_ollama_profile(
    monkeypatch,
    tmp_path,
) -> None:
    inventory = _profile_inventory(total_ram=16 * GIB, free_disk=64 * GIB)
    install_events: list[tuple[object, ...]] = []
    monkeypatch.setattr(
        machine_inventory_module,
        "collect_machine_inventory",
        lambda **_kwargs: inventory,
    )

    from cert_prep_ollama import profile_installer as profile_installer_module

    monkeypatch.setattr(
        profile_installer_module,
        "OllamaProfileInstaller",
        lambda profile, **_kwargs: FakeProfileInstaller(profile, install_events),
    )
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                llm_provider="ollama",
            ),
            llm_installation_async_jobs=False,
        )
    )

    response = client.post("/llm/installations", headers=AUTH_HEADERS, json={"kind": "ollama_model"})

    assert response.status_code == 202
    assert response.json()["model"] == "cert-prep-qwen3.5-4b-study-8k"
    assert response.json()["status"] == "succeeded"
    assert install_events == [
        ("init", DEFAULT_PROFILE_ID),
        ("install", "cert-prep-qwen3.5-4b-study-8k"),
    ]

def test_model_download_starts_only_from_explicit_post(tmp_path) -> None:
    provider = RecordingDownloadProvider(available=False, detail="model not found")
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            llm_provider=provider,
            llm_installation_async_jobs=False,
        )
    )

    response = client.post("/llm/installations", headers=AUTH_HEADERS, json={"kind": "ollama_model"})

    assert response.status_code == 202
    assert provider.pull_calls == 1
    assert response.json() == {
        "id": response.json()["id"],
        "kind": "ollama_model",
        "provider": "ollama",
        "model": DEFAULT_OLLAMA_MODEL,
        "status": "succeeded",
        "phase": "completed",
        "cancellable": False,
        "detail": "model download complete",
        "completed": 100,
        "total": 100,
        "created_at": response.json()["created_at"],
        "updated_at": response.json()["updated_at"],
        "commit_started_at": response.json()["commit_started_at"],
        "error": None,
    }

def test_model_download_installs_fixed_raw_model_when_profile_disabled(tmp_path) -> None:
    provider = RecordingDownloadProvider(available=False, detail="model not found")
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                llm_provider="ollama",
                ollama_profile_enabled=False,
            ),
            llm_provider=provider,
            llm_installation_async_jobs=False,
        )
    )

    response = client.post("/llm/installations", headers=AUTH_HEADERS, json={"kind": "ollama_model"})

    assert response.status_code == 202
    assert provider.pull_calls == 1
    assert response.json()["model"] == DEFAULT_OLLAMA_MODEL
    assert response.json()["status"] == "succeeded"

def test_model_download_poll_returns_job_status(tmp_path) -> None:
    provider = RecordingDownloadProvider(available=False, detail="model not found")
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            llm_provider=provider,
            llm_installation_async_jobs=False,
        )
    )
    started = client.post("/llm/installations", headers=AUTH_HEADERS, json={"kind": "ollama_model"}).json()

    response = client.get(f"/llm/installations/{started['id']}", headers=AUTH_HEADERS)

    assert response.status_code == 200
    assert response.json()["id"] == started["id"]
    assert response.json()["status"] == "succeeded"

def test_model_download_reuses_existing_running_job(tmp_path, monkeypatch) -> None:
    release_pull = Event()
    progress_emitted = Event()
    provider = BlockingDownloadProvider(release_pull)
    original_pull = provider.pull_model

    def pull_model(progress):
        def record(item):
            progress(item)
            progress_emitted.set()
        original_pull(record)

    monkeypatch.setattr(provider, "pull_model", pull_model)
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            llm_provider=provider,
        )
    )
    installation = client.app.state.llm_installation
    original_start = llm_installations.download_selected_model

    def start_after_progress(runtime):
        snapshot = original_start(runtime)
        assert progress_emitted.wait(timeout=5)
        return llm_installations.view_llm_installation(runtime, snapshot.id)

    monkeypatch.setattr(llm_installations, "download_selected_model", start_after_progress)
    try:
        first = client.post("/llm/installations", headers=AUTH_HEADERS, json={"kind": "ollama_model"})
        second = client.post("/llm/installations", headers=AUTH_HEADERS, json={"kind": "ollama_model"})
    finally:
        release_pull.set()
        for worker in installation.work.workers():
            worker.join(timeout=5)
            assert not worker.is_alive()
        llm_installations.stop_llm_installations(installation)

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
            llm_installation_async_jobs=False,
        )
    )

    response = client.post("/llm/installations", headers=AUTH_HEADERS, json={"kind": "ollama_model"})

    assert response.status_code == 202
    assert response.json()["status"] == "failed"
    assert response.json()["detail"] == "Ollama unavailable: connection refused"

def test_model_download_rejects_provider_without_pull_support(client, auth_headers) -> None:
    response = client.post("/llm/installations", headers=auth_headers, json={"kind": "ollama_model"})

    assert response.status_code == 503
    assert response.json() == {
        "code": "provider_unavailable",
        "message": "Configured LLM provider does not support model downloads.",
    }


def test_model_download_runs_provider_neutral_onboarding_gate(tmp_path) -> None:
    provider = RecordingOnboardingProvider()
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                llm_provider="ollama",
            ),
            llm_provider=provider,
            llm_installation_async_jobs=False,
        )
    )

    response = client.post("/llm/installations", headers=AUTH_HEADERS, json={"kind": "ollama_model"})

    assert response.status_code == 202
    assert response.json()["status"] == "succeeded"
    assert provider.events == [
        "validate/list",
        "pull",
        "check/serve/models/completion",
    ]
