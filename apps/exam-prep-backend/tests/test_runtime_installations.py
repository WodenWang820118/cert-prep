from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import subprocess
from zipfile import ZipFile

from fastapi.testclient import TestClient

from exam_prep_backend.app import create_app
from exam_prep_backend.config import Settings
from exam_prep_backend.domains.runtime_installations import (
    WindowsMLOcrRuntimeInstaller,
    OllamaRuntimeInstaller,
    PaddleOcrRuntimeInstaller,
    RuntimeInstallProgress,
    RuntimeInstallationManager,
    RuntimeInstallationStatus,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
    run_ocr_runtime_command,
)
from exam_prep_backend.domains.runtime_installations import installers as runtime_installers
from exam_prep_backend.domains.runtime_installations import ollama as runtime_ollama
from exam_prep_backend.domains.source_documents.ocr import OCRHealth, OCRPageResult


AUTH_HEADERS = {"Authorization": "Bearer test-token"}


def test_runtime_requirements_are_read_only(tmp_path: Path) -> None:
    installer = FakeInstaller(RuntimeRequirementKind.OLLAMA)
    manager = RuntimeInstallationManager(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        llm_provider=object(),
        ocr_provider=FakeOcrProvider(),
        installers=[installer],
        async_jobs=False,
    )
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            runtime_installation_manager=manager,
        )
    )

    response = client.get("/runtime/requirements", headers=AUTH_HEADERS)

    assert response.status_code == 200
    assert response.json()["items"][0]["kind"] == "ollama"
    assert installer.install_calls == 0


def test_runtime_installation_starts_only_from_post(tmp_path: Path) -> None:
    installer = FakeInstaller(RuntimeRequirementKind.OLLAMA_MODEL)
    manager = RuntimeInstallationManager(
        settings=Settings(data_dir=tmp_path, api_token="test-token"),
        llm_provider=object(),
        ocr_provider=FakeOcrProvider(),
        installers=[installer],
        async_jobs=False,
    )
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            runtime_installation_manager=manager,
        )
    )

    response = client.post("/runtime/installations/ollama_model", headers=AUTH_HEADERS)

    assert response.status_code == 202
    assert response.json()["status"] == "succeeded"
    assert response.json()["completed"] == 100
    assert installer.install_calls == 1


def test_ollama_runtime_install_uses_winget_and_starts_api(
    monkeypatch, tmp_path: Path
) -> None:
    commands: list[list[str]] = []
    started: list[tuple[str, Path | None]] = []
    progress_messages: list[str] = []

    def fake_run(command, **_kwargs):
        commands.append(command)
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(runtime_installers.os, "name", "nt")
    monkeypatch.setattr(
        runtime_installers.shutil,
        "which",
        lambda name: "C:/Windows/System32/winget.exe" if name == "winget" else None,
    )
    monkeypatch.setattr(runtime_installers.subprocess, "run", fake_run)
    monkeypatch.setattr(
        runtime_installers,
        "resolve_ollama_executable",
        lambda: Path("C:/Users/User/AppData/Local/Programs/Ollama/ollama.exe"),
    )
    monkeypatch.setattr(
        runtime_installers,
        "ensure_ollama_server_running",
        lambda host, *, executable=None: started.append((host, executable)) or True,
    )

    status = OllamaRuntimeInstaller(
        Settings(data_dir=tmp_path, ollama_host="http://127.0.0.1:11434")
    ).install(lambda progress: progress_messages.append(progress.detail))

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
    assert progress_messages == [
        "Starting the Ollama Windows installer.",
        "Starting the Ollama local API.",
    ]


def test_ollama_runtime_install_falls_back_to_official_script_without_winget(
    monkeypatch, tmp_path: Path
) -> None:
    commands: list[list[str]] = []

    def fake_run(command, **_kwargs):
        commands.append(command)
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(runtime_installers.os, "name", "nt")
    monkeypatch.setattr(runtime_installers.shutil, "which", lambda _name: None)
    monkeypatch.setattr(runtime_installers.subprocess, "run", fake_run)
    monkeypatch.setattr(
        runtime_installers,
        "resolve_ollama_executable",
        lambda: Path("C:/Users/User/AppData/Local/Programs/Ollama/ollama.exe"),
    )
    monkeypatch.setattr(
        runtime_installers,
        "ensure_ollama_server_running",
        lambda _host, *, executable=None: True,
    )

    status = OllamaRuntimeInstaller(Settings(data_dir=tmp_path)).install(lambda _progress: None)

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


def test_ollama_server_bind_host_uses_url_authority() -> None:
    assert runtime_ollama._ollama_server_bind_host("http://127.0.0.1:11434") == (
        "127.0.0.1:11434"
    )
    assert runtime_ollama._ollama_server_bind_host("127.0.0.1:11434") == (
        "127.0.0.1:11434"
    )


def test_paddle_runtime_install_rejects_checksum_mismatch(tmp_path: Path) -> None:
    artifact_path = tmp_path / "exam-prep-ocr-runtime-x86_64-pc-windows-msvc.zip"
    with ZipFile(artifact_path, "w") as archive:
        archive.writestr("exam-prep-ocr-runtime.cmd", "@echo off\r\nexit /b 0\r\n")
    manifest_path = tmp_path / "ocr-runtime-manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "version": "0.1.0",
                "target": "x86_64-pc-windows-msvc",
                "entrypoint": "exam-prep-ocr-runtime.cmd",
                "artifact": {
                    "file_name": artifact_path.name,
                    "sha256": "0" * 64,
                    "bytes": artifact_path.stat().st_size,
                    "url": None,
                },
            }
        ),
        encoding="utf-8",
    )
    settings = Settings(
        data_dir=tmp_path,
        api_token="test-token",
        ocr_runtime_manifest_path=manifest_path,
    )
    manager = RuntimeInstallationManager(
        settings=settings,
        llm_provider=object(),
        ocr_provider=FakeOcrProvider(),
        installers=[PaddleOcrRuntimeInstaller(settings, FakeOcrProvider())],
        async_jobs=False,
    )

    response = manager.start_installation(RuntimeRequirementKind.PADDLE_OCR)

    assert response.status == RuntimeInstallationStatus.FAILED
    assert response.error == "OCR runtime artifact checksum mismatch."


def test_windowsml_runtime_install_verifies_and_installs_artifact(tmp_path: Path) -> None:
    artifact_path = tmp_path / "exam-prep-ocr-windowsml-runtime-x86_64-pc-windows-msvc.zip"
    with ZipFile(artifact_path, "w") as archive:
        archive.writestr("exam-prep-ocr-windowsml-runtime.cmd", "@echo off\r\nexit /b 0\r\n")
        archive.writestr("det_model.onnx", "det")
        archive.writestr("rec_model.onnx", "rec")
        archive.writestr("rec_char_dict.txt", "A\n")
        archive.writestr("pipeline.json", "{}")
    sha256 = _sha256_file(artifact_path)
    manifest_path = tmp_path / "windowsml-ocr-runtime-manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "kind": "windowsml_ocr",
                "version": "0.1.0",
                "target": "x86_64-pc-windows-msvc",
                "entrypoint": "exam-prep-ocr-windowsml-runtime.cmd",
                "artifact": {
                    "file_name": artifact_path.name,
                    "sha256": sha256,
                    "bytes": artifact_path.stat().st_size,
                    "url": None,
                },
            }
        ),
        encoding="utf-8",
    )
    runtime_dir = tmp_path / "installed-windowsml"
    settings = Settings(
        data_dir=tmp_path,
        api_token="test-token",
        windowsml_ocr_runtime_dir=runtime_dir,
        windowsml_ocr_runtime_manifest_path=manifest_path,
    )
    manager = RuntimeInstallationManager(
        settings=settings,
        llm_provider=object(),
        ocr_provider=FakeOcrProvider(),
        installers=[WindowsMLOcrRuntimeInstaller(settings, FakeWindowsMLOcrProvider(runtime_dir))],
        async_jobs=False,
    )

    response = manager.start_installation(RuntimeRequirementKind.WINDOWSML_OCR)

    assert response.status == RuntimeInstallationStatus.SUCCEEDED
    installed_manifest = json.loads((runtime_dir / "runtime-manifest.json").read_text())
    assert installed_manifest["kind"] == "windowsml_ocr"
    assert (runtime_dir / "exam-prep-ocr-windowsml-runtime.cmd").is_file()


def test_ocr_runtime_command_decodes_utf8_output(monkeypatch, tmp_path: Path) -> None:
    calls: dict[str, object] = {}

    def fake_run(command, **kwargs):
        calls.update(kwargs)
        return subprocess.CompletedProcess(
            command,
            0,
            stdout='{"text":"\\u65e5\\u672c\\u8a9e","duration_ms":1}\n',
            stderr="model warning\n",
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    output = run_ocr_runtime_command(tmp_path / "exam-prep-ocr-runtime.exe", [])

    assert json.loads(output)["text"].encode("unicode_escape").decode("ascii") == (
        "\\u65e5\\u672c\\u8a9e"
    )
    assert calls["encoding"] == "utf-8"
    assert calls["errors"] == "replace"


@dataclass
class FakeInstaller:
    kind: RuntimeRequirementKind
    install_calls: int = 0
    provider: str = "test-runtime"
    model: str = ""

    def requirement(self) -> RuntimeRequirementSnapshot:
        return RuntimeRequirementSnapshot(
            kind=self.kind,
            label=self.kind.value,
            available=False,
            detail=f"{self.kind.value} missing",
            unavailable_reason=f"{self.kind.value}_missing",
        )

    def install(self, progress) -> RuntimeInstallationStatus:
        self.install_calls += 1
        progress(RuntimeInstallProgress("halfway", completed=50, total=100))
        progress(RuntimeInstallProgress("done", completed=100, total=100))
        return RuntimeInstallationStatus.SUCCEEDED


class FakeOcrProvider:
    provider = "paddle"
    engine = "paddleocr"

    def health(self) -> OCRHealth:
        return OCRHealth(
            provider=self.provider,
            engine=self.engine,
            available=False,
            detail="PaddleOCR runtime is not installed.",
            python_version="3.13.5",
            paddle_version=None,
            paddleocr_version=None,
            selected_device=None,
            cuda_available=False,
            gpu_count=0,
            model_cache_dir=None,
            fallback_reason=None,
            unavailable_reason="paddle_runtime_missing",
        )

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        raise AssertionError("OCR should not run in runtime installation tests.")


class FakeWindowsMLOcrProvider(FakeOcrProvider):
    provider = "windowsml"
    engine = "onnxruntime-windowsml"

    def __init__(self, runtime_dir: Path) -> None:
        self._runtime_dir = runtime_dir

    def health(self) -> OCRHealth:
        return OCRHealth(
            provider=self.provider,
            engine=self.engine,
            available=(self._runtime_dir / "runtime-manifest.json").is_file(),
            detail="WindowsML OCR runtime is ready.",
            python_version="3.13.5",
            paddle_version=None,
            paddleocr_version="1.24.4",
            selected_device="amd_windowsml",
            cuda_available=False,
            gpu_count=0,
            model_cache_dir=str(self._runtime_dir),
            fallback_reason=None,
            unavailable_reason=None,
        )
def _sha256_file(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
