"""Unit tests for OllamaServerCoordinator wiring into provider, installers, and FastAPI app."""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock

from fastapi.testclient import TestClient

from cert_prep_backend.ai_providers.application.ports import MachineInventory
from cert_prep_backend.ai_providers.infrastructure.ollama_transport import OllamaProvider
from cert_prep_backend.ai_providers.infrastructure.provider import (
    lazy_provider_from_settings,
    provider_from_settings,
)
from cert_prep_backend.ai_providers.infrastructure.runtime_installers import (
    LazyOllamaProfileInstaller,
    configured_installer_choices,
)
from cert_prep_backend.api.app import create_app
from cert_prep_backend.platform.config import Settings
from cert_prep_contracts.hardware import (
    MachineCpuSnapshot,
    MachineInventorySnapshot,
    MachineRamSnapshot,
    MachineStorageSnapshot,
)
from cert_prep_contracts.llm_profiles import OllamaModelProfile
from cert_prep_ollama.installers import OllamaRuntimeInstaller
from cert_prep_ollama.profile_installer import OllamaProfileInstaller
from cert_prep_ollama.server_coordinator import OllamaServerCoordinator


def _mock_coordinator() -> OllamaServerCoordinator:
    coordinator = MagicMock(spec=OllamaServerCoordinator)
    coordinator.ensure_running.return_value = True
    coordinator.admission.return_value.__enter__ = MagicMock(return_value=None)
    coordinator.admission.return_value.__exit__ = MagicMock(return_value=None)
    coordinator.after_model_load.return_value = None
    coordinator.device_execution.return_value = None
    coordinator.ownership = "none"
    return coordinator


class _DummyInventory(MachineInventory):
    def inventory(self) -> MachineInventorySnapshot:
        return MachineInventorySnapshot(
            platform="Windows",
            platform_version="10.0.26100",
            architecture="AMD64",
            cpu=MachineCpuSnapshot(architecture="AMD64"),
            ram=MachineRamSnapshot(16 * 1024**3, 8 * 1024**3),
            storage=MachineStorageSnapshot("C:\\", 32 * 1024**3, 64 * 1024**3),
            accelerators=(),
        )


def test_provider_uses_shared_coordinator_on_health_and_generation() -> None:
    coordinator = _mock_coordinator()
    fake_client = MagicMock()
    fake_client.list.side_effect = [Exception("initial connection failed"), {"models": [{"name": "test-model"}]}]
    fake_client.chat.return_value = {"message": {"content": "{\"key\": \"val\"}"}}

    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="test-model",
        timeout_seconds=30.0,
        client=fake_client,
        server=coordinator,
    )

    # 1. Health retries using coordinator.ensure_running
    health = provider.health()
    assert health.available is True
    coordinator.ensure_running.assert_called_once()

    # 2. Structured JSON generation enters admission and calls after_model_load
    fake_client.list.side_effect = None
    fake_client.list.return_value = {"models": [{"name": "test-model"}]}
    result = provider.generate_structured_json(
        messages=[{"role": "user", "content": "hi"}],
        json_schema={},
    )
    assert result == "{\"key\": \"val\"}"
    coordinator.admission.assert_called_once()
    coordinator.after_model_load.assert_called_once()


def test_generation_checks_the_model_inside_admission() -> None:
    # A corrective restart holds admission back, so the model check must wait for it too.
    events: list[str] = []
    coordinator = _mock_coordinator()

    @contextmanager
    def admission():
        events.append("enter")
        yield
        events.append("exit")

    coordinator.admission.side_effect = admission
    fake_client = MagicMock()
    fake_client.list.side_effect = lambda: events.append("list") or {"models": [{"name": "test-model"}]}
    fake_client.chat.return_value = {"message": {"content": "{\"key\": \"val\"}"}}
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="test-model",
        timeout_seconds=30.0,
        client=fake_client,
        server=coordinator,
    )

    provider.generate_structured_json(messages=[{"role": "user", "content": "hi"}], json_schema={})

    assert events == ["enter", "list", "exit"]


def test_runtime_installer_uses_shared_coordinator() -> None:
    coordinator = _mock_coordinator()
    installer = OllamaRuntimeInstaller(
        ollama_host="http://127.0.0.1:11434",
        server=coordinator,
    )

    progress_calls = []

    # Mock subprocess.run for Windows install command
    from unittest.mock import patch

    with (
        patch("cert_prep_ollama.installers.os.name", "nt"),
        patch("cert_prep_ollama.installers.subprocess.run") as mock_run,
        patch(
            "cert_prep_ollama.installers.resolve_ollama_executable",
            return_value=Path("C:\\Ollama\\ollama.exe"),
        ),
    ):
        mock_run.return_value = MagicMock(returncode=0)
        installer.install(lambda p: progress_calls.append(p))

    coordinator.ensure_running.assert_called_once()


def test_profile_installer_uses_shared_coordinator() -> None:
    coordinator = _mock_coordinator()
    dummy_profile = OllamaModelProfile.from_mapping(
        profile_id="test-p",
        display_name="Test Profile",
        base_model="qwen3.5:4b",
        local_model="test-local",
        context_window=4096,
        system_prompt="sys",
        parameters={},
        min_total_ram_bytes=4 * 1024**3,
        min_available_ram_bytes=2 * 1024**3,
        min_free_disk_bytes=4 * 1024**3,
        description="desc",
    )

    installer = OllamaProfileInstaller(
        profile=dummy_profile,
        host="http://127.0.0.1:11434",
        client=MagicMock(),
        server=coordinator,
    )

    installer._prepare_server()
    coordinator.ensure_running.assert_called_once()


def test_configured_installer_choices_propagates_coordinator() -> None:
    coordinator = _mock_coordinator()
    settings = Settings(
        llm_provider="ollama",
        ollama_profile_enabled=True,
        ollama_host="http://127.0.0.1:11434",
    )
    dummy_provider = MagicMock()
    dummy_provider.runtime_requirement_kind = OllamaRuntimeInstaller.kind
    dummy_provider.profile_selection = None

    runtimes, model = configured_installer_choices(
        settings,
        dummy_provider,
        _DummyInventory(),
        lambda: MagicMock(),
        server=coordinator,
    )

    assert len(runtimes) == 1
    assert runtimes[0]._server is coordinator
    assert isinstance(model, LazyOllamaProfileInstaller)
    assert model._server is coordinator


def test_create_app_builds_one_coordinator_without_spawning_and_closes_it_on_shutdown(
    tmp_path: Path,
) -> None:
    settings = Settings(
        data_dir=tmp_path,
        api_token="test-token",
        llm_provider="fake",
    )

    app = create_app(
        settings=settings,
        document_processing_async_jobs=False,
    )

    # 1. Assert one coordinator created in app.state.ollama_server
    assert hasattr(app.state, "ollama_server")
    coordinator = app.state.ollama_server
    assert isinstance(coordinator, OllamaServerCoordinator)

    # 2. Assert no process spawned during app creation
    assert coordinator.ownership == "none"
    assert coordinator._process is None

    # Mock close to verify lifespan shutdown triggers it
    close_mock = MagicMock(wraps=coordinator.close)
    coordinator.close = close_mock

    # 3. Running lifespan and shutting down closes coordinator
    with TestClient(app) as client:
        response = client.get("/health")
        assert response.status_code == 200

    close_mock.assert_called_once()


def test_provider_from_settings_wires_coordinator() -> None:
    coordinator = _mock_coordinator()
    settings = Settings(
        llm_provider="ollama",
        ollama_profile_enabled=False,
    )
    provider = provider_from_settings(settings, server=coordinator)
    assert isinstance(provider, OllamaProvider)
    assert provider._server is coordinator


def test_lazy_provider_from_settings_delegates_device_execution() -> None:
    coordinator = _mock_coordinator()
    coordinator.device_execution.return_value = "fake-device-execution"
    settings = Settings(
        llm_provider="ollama",
        ollama_profile_enabled=False,
    )
    lazy_provider = lazy_provider_from_settings(settings, server=coordinator)
    assert hasattr(lazy_provider, "device_execution")
    assert lazy_provider.device_execution() == "fake-device-execution"

