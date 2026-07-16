from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import subprocess

import pytest

from cert_prep_contracts.llm import ModelPullProgress
from cert_prep_contracts.runtime import RuntimeInstallationStatus, RuntimeRequirementKind
from cert_prep_ollama import installers as installer_module
from cert_prep_ollama import server as server_module
from cert_prep_ollama.exceptions import ProviderUnavailableError
from cert_prep_ollama.installers import OllamaModelInstaller, OllamaRuntimeInstaller
from cert_prep_ollama.models import (
    extract_model_names,
    pull_progress,
)


@dataclass(frozen=True)
class _Model:
    model: str


@dataclass(frozen=True)
class _ModelList:
    models: list[object]


def test_extract_model_names_accepts_client_objects_and_dicts() -> None:
    response = _ModelList(
        models=[
            _Model("qwen3.5:4b"),
            {"name": "other-model"},
            {"model": "gemma4:12b"},
            {"model": None},
        ]
    )

    assert extract_model_names(response) == {"qwen3.5:4b", "other-model", "gemma4:12b"}
    assert extract_model_names({"models": [{"model": "llama3.2:3b"}]}) == {"llama3.2:3b"}


def test_pull_progress_normalizes_ollama_stream_shapes() -> None:
    assert pull_progress(
        {"status": "pulling manifest", "completed": 128, "total": 256}
    ) == ModelPullProgress(status="pulling manifest", completed=128, total=256)

    assert pull_progress({"status": 123, "completed": "128", "total": 256}) == (
        ModelPullProgress(status="downloading model", completed=None, total=256)
    )


def test_ollama_server_bind_host_uses_url_authority() -> None:
    assert server_module._ollama_server_bind_host("http://127.0.0.1:11434") == (
        "127.0.0.1:11434"
    )
    assert server_module._ollama_server_bind_host("127.0.0.1:11434") == (
        "127.0.0.1:11434"
    )


def test_ollama_runtime_requirement_reports_missing_executable(monkeypatch) -> None:
    monkeypatch.setattr(installer_module, "resolve_ollama_executable", lambda: None)

    requirement = OllamaRuntimeInstaller().requirement()

    assert requirement.kind == RuntimeRequirementKind.OLLAMA
    assert requirement.available is False
    assert requirement.unavailable_reason == "ollama_missing"


def test_ollama_runtime_install_uses_winget_and_starts_api(monkeypatch) -> None:
    commands: list[list[str]] = []
    started: list[tuple[str, Path | None]] = []

    def fake_run(command, **_kwargs):
        commands.append(command)
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(installer_module.os, "name", "nt")
    monkeypatch.setattr(
        installer_module.shutil,
        "which",
        lambda name: "C:/Windows/System32/winget.exe" if name == "winget" else None,
    )
    monkeypatch.setattr(installer_module.subprocess, "run", fake_run)
    monkeypatch.setattr(
        installer_module,
        "resolve_ollama_executable",
        lambda: Path("C:/Users/User/AppData/Local/Programs/Ollama/ollama.exe"),
    )
    monkeypatch.setattr(
        installer_module,
        "ensure_ollama_server_running",
        lambda host, *, executable=None: started.append((host, executable)) or True,
    )

    status = OllamaRuntimeInstaller(
        ollama_host="http://127.0.0.1:11434",
    ).install(lambda _progress: None)

    assert status == RuntimeInstallationStatus.SUCCEEDED
    assert commands == [
        [
            "C:/Windows/System32/winget.exe",
            "install",
            "--id",
            "Ollama.Ollama",
            "-e",
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements",
        ]
    ]
    assert started == [
        (
            "http://127.0.0.1:11434",
            Path("C:/Users/User/AppData/Local/Programs/Ollama/ollama.exe"),
        )
    ]


def test_ollama_runtime_install_falls_back_to_official_script_without_winget(
    monkeypatch,
) -> None:
    commands: list[list[str]] = []

    def fake_run(command, **_kwargs):
        commands.append(command)
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(installer_module.os, "name", "nt")
    monkeypatch.setattr(installer_module.shutil, "which", lambda _name: None)
    monkeypatch.setattr(installer_module.subprocess, "run", fake_run)
    monkeypatch.setattr(
        installer_module,
        "resolve_ollama_executable",
        lambda: Path("C:/Users/User/AppData/Local/Programs/Ollama/ollama.exe"),
    )
    monkeypatch.setattr(
        installer_module,
        "ensure_ollama_server_running",
        lambda _host, *, executable=None: True,
    )

    status = OllamaRuntimeInstaller().install(lambda _progress: None)

    assert status == RuntimeInstallationStatus.SUCCEEDED
    assert commands == [
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://ollama.com/install.ps1 | iex",
        ]
    ]


def test_ollama_runtime_install_raises_provider_error_on_command_failure(monkeypatch) -> None:
    def fake_run(command, **_kwargs):
        return subprocess.CompletedProcess(command, 1, stdout="", stderr="winget failed")

    monkeypatch.setattr(installer_module.os, "name", "nt")
    monkeypatch.setattr(
        installer_module.shutil,
        "which",
        lambda name: "C:/Windows/System32/winget.exe" if name == "winget" else None,
    )
    monkeypatch.setattr(installer_module.subprocess, "run", fake_run)

    with pytest.raises(ProviderUnavailableError, match="winget failed"):
        OllamaRuntimeInstaller().install(lambda _progress: None)


def test_ollama_model_installer_rejects_unsupported_provider() -> None:
    installer = OllamaModelInstaller(object())

    requirement = installer.requirement()

    assert requirement.kind == RuntimeRequirementKind.OLLAMA_MODEL
    assert requirement.available is False
    assert requirement.unavailable_reason == "unsupported_provider"
    with pytest.raises(ProviderUnavailableError, match="does not support model downloads"):
        installer.validate_installable()


def test_ollama_model_installer_forwards_pull_progress() -> None:
    progress: list[tuple[str, int | None, int | None]] = []

    class Provider:
        provider = "ollama"
        model = "qwen3.5:4b"

        def pull_model(self, callback):
            callback(ModelPullProgress(status="pulling manifest", completed=128, total=256))

    status = OllamaModelInstaller(Provider()).install(
        lambda item: progress.append((item.detail, item.completed, item.total))
    )

    assert status == RuntimeInstallationStatus.SUCCEEDED
    assert progress == [("pulling manifest", 128, 256)]
