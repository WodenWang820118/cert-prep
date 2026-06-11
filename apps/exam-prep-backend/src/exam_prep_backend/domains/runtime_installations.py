from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
from threading import Lock, Thread
from typing import Any, Protocol
from urllib.request import urlretrieve
from uuid import uuid4
from zipfile import ZipFile

from exam_prep_backend.config import Settings
from exam_prep_backend.domains.mock_exams.ports import ModelPullProgress
from exam_prep_backend.domains.source_documents.ocr import OCRProvider
from exam_prep_backend.errors import ProviderUnavailableError


class RuntimeRequirementKind(StrEnum):
    OLLAMA = "ollama"
    OLLAMA_MODEL = "ollama_model"
    PADDLE_OCR = "paddle_ocr"


class RuntimeInstallationStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    WAITING_FOR_USER = "waiting_for_user"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class RuntimeRequirementSnapshot:
    kind: RuntimeRequirementKind
    label: str
    available: bool
    detail: str
    unavailable_reason: str | None
    version: str | None = None
    bytes: int | None = None
    installed_path: str | None = None


@dataclass(frozen=True, slots=True)
class RuntimeInstallationSnapshot:
    id: str
    kind: RuntimeRequirementKind
    provider: str
    model: str
    status: RuntimeInstallationStatus
    detail: str
    completed: int | None
    total: int | None
    created_at: str
    updated_at: str
    error: str | None = None


@dataclass(frozen=True, slots=True)
class RuntimeInstallProgress:
    detail: str
    completed: int | None = None
    total: int | None = None


@dataclass(slots=True)
class _RuntimeInstallationJob:
    id: str
    kind: RuntimeRequirementKind
    provider: str
    model: str
    status: RuntimeInstallationStatus
    detail: str
    completed: int | None
    total: int | None
    created_at: datetime
    updated_at: datetime
    error: str | None = None

    def snapshot(self) -> RuntimeInstallationSnapshot:
        return RuntimeInstallationSnapshot(
            id=self.id,
            kind=self.kind,
            provider=self.provider,
            model=self.model,
            status=self.status,
            detail=self.detail,
            completed=self.completed,
            total=self.total,
            created_at=self.created_at.isoformat(),
            updated_at=self.updated_at.isoformat(),
            error=self.error,
        )


class RuntimeInstaller(Protocol):
    kind: RuntimeRequirementKind
    provider: str
    model: str

    def requirement(self) -> RuntimeRequirementSnapshot:
        pass

    def install(self, progress: Callable[[RuntimeInstallProgress], None]) -> RuntimeInstallationStatus:
        pass


class _Missing:
    pass


_MISSING = _Missing()


class RuntimeInstallationManager:
    """Coordinates explicit, user-confirmed local runtime installations."""

    def __init__(
        self,
        *,
        settings: Settings,
        llm_provider: object,
        ocr_provider: OCRProvider,
        async_jobs: bool = True,
        installers: list[RuntimeInstaller] | None = None,
    ) -> None:
        self._settings = settings
        self._async_jobs = async_jobs
        self._installers = {
            installer.kind: installer
            for installer in (
                installers
                or [
                    OllamaRuntimeInstaller(settings),
                    OllamaModelInstaller(llm_provider),
                    PaddleOcrRuntimeInstaller(settings, ocr_provider),
                ]
            )
        }
        self._jobs: dict[str, _RuntimeInstallationJob] = {}
        self._lock = Lock()

    def requirements(self) -> list[RuntimeRequirementSnapshot]:
        return [
            self._installers[kind].requirement()
            for kind in RuntimeRequirementKind
            if kind in self._installers
        ]

    def start_installation(self, kind: RuntimeRequirementKind | str) -> RuntimeInstallationSnapshot:
        installer = self._installer(RuntimeRequirementKind(kind))
        requirement = installer.requirement()
        if requirement.available:
            return self._completed_snapshot(installer, requirement)
        validate = getattr(installer, "validate_installable", None)
        if callable(validate):
            validate()

        with self._lock:
            existing = self._active_job_for(installer.kind)
            if existing is not None:
                return existing.snapshot()

            now = _utcnow()
            job = _RuntimeInstallationJob(
                id=str(uuid4()),
                kind=installer.kind,
                provider=installer.provider,
                model=installer.model,
                status=RuntimeInstallationStatus.QUEUED,
                detail=f"{requirement.label} installation queued",
                completed=None,
                total=requirement.bytes,
                created_at=now,
                updated_at=now,
            )
            self._jobs[job.id] = job

        if self._async_jobs:
            Thread(target=self._run_installation, args=(job.id, installer), daemon=True).start()
        else:
            self._run_installation(job.id, installer)
        return self.get_installation(job.id)

    def get_installation(self, job_id: str) -> RuntimeInstallationSnapshot:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise KeyError(job_id)
            snapshot = job.snapshot()

        if snapshot.status == RuntimeInstallationStatus.WAITING_FOR_USER:
            installer = self._installers.get(snapshot.kind)
            if installer is not None:
                requirement = installer.requirement()
                if requirement.available:
                    self._update_job(
                        job_id,
                        status=RuntimeInstallationStatus.SUCCEEDED,
                        detail=f"{requirement.label} is ready",
                        completed=requirement.bytes,
                        total=requirement.bytes,
                        error=None,
                    )
                    return self.get_installation(job_id)
        return snapshot

    def _run_installation(self, job_id: str, installer: RuntimeInstaller) -> None:
        self._update_job(
            job_id,
            status=RuntimeInstallationStatus.RUNNING,
            detail=f"{installer.provider} installation running",
        )
        try:
            status = installer.install(lambda progress: self._record_progress(job_id, progress))
        except Exception as exc:
            self._update_job(
                job_id,
                status=RuntimeInstallationStatus.FAILED,
                detail=str(exc),
                error=str(exc),
            )
            return

        requirement = installer.requirement()
        if status == RuntimeInstallationStatus.WAITING_FOR_USER:
            self._update_job(
                job_id,
                status=status,
                detail=requirement.detail,
                completed=None,
                total=requirement.bytes,
            )
            return
        snapshot = self.get_installation(job_id)

        self._update_job(
            job_id,
            status=RuntimeInstallationStatus.SUCCEEDED,
            detail=(
                "model download complete"
                if installer.kind == RuntimeRequirementKind.OLLAMA_MODEL
                else snapshot.detail or f"{requirement.label} is ready"
            ),
            completed=snapshot.completed if snapshot.completed is not None else requirement.bytes,
            total=snapshot.total if snapshot.total is not None else requirement.bytes,
        )

    def _record_progress(self, job_id: str, progress: RuntimeInstallProgress) -> None:
        self._update_job(
            job_id,
            status=RuntimeInstallationStatus.RUNNING,
            detail=progress.detail,
            completed=progress.completed,
            total=progress.total,
        )

    def _update_job(
        self,
        job_id: str,
        *,
        status: RuntimeInstallationStatus,
        detail: str,
        completed: int | None | object = _MISSING,
        total: int | None | object = _MISSING,
        error: str | None | object = _MISSING,
    ) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job.status = status
            job.detail = detail
            if completed is not _MISSING:
                job.completed = completed  # type: ignore[assignment]
            if total is not _MISSING:
                job.total = total  # type: ignore[assignment]
            if error is not _MISSING:
                job.error = error  # type: ignore[assignment]
            job.updated_at = _utcnow()

    def _active_job_for(self, kind: RuntimeRequirementKind) -> _RuntimeInstallationJob | None:
        for job in self._jobs.values():
            if job.kind == kind and job.status in {
                RuntimeInstallationStatus.QUEUED,
                RuntimeInstallationStatus.RUNNING,
                RuntimeInstallationStatus.WAITING_FOR_USER,
            }:
                return job
        return None

    def _installer(self, kind: RuntimeRequirementKind) -> RuntimeInstaller:
        installer = self._installers.get(kind)
        if installer is None:
            raise ProviderUnavailableError(f"No installer is configured for {kind.value}.")
        return installer

    def _completed_snapshot(
        self, installer: RuntimeInstaller, requirement: RuntimeRequirementSnapshot
    ) -> RuntimeInstallationSnapshot:
        now = _utcnow().isoformat()
        return RuntimeInstallationSnapshot(
            id=str(uuid4()),
            kind=installer.kind,
            provider=installer.provider,
            model=installer.model,
            status=RuntimeInstallationStatus.SUCCEEDED,
            detail=f"{requirement.label} is ready",
            completed=requirement.bytes,
            total=requirement.bytes,
            created_at=now,
            updated_at=now,
        )


class OllamaRuntimeInstaller:
    kind = RuntimeRequirementKind.OLLAMA
    provider = "ollama"
    model = ""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def requirement(self) -> RuntimeRequirementSnapshot:
        executable = resolve_ollama_executable()
        if executable is None:
            return RuntimeRequirementSnapshot(
                kind=self.kind,
                label="Ollama",
                available=False,
                detail="Ollama is not installed.",
                unavailable_reason="ollama_missing",
            )
        return RuntimeRequirementSnapshot(
            kind=self.kind,
            label="Ollama",
            available=True,
            detail="Ollama is installed.",
            unavailable_reason=None,
            installed_path=str(executable),
        )

    def install(self, progress: Callable[[RuntimeInstallProgress], None]) -> RuntimeInstallationStatus:
        progress(RuntimeInstallProgress("Starting the official Ollama Windows installer."))
        if os.name != "nt":
            raise ProviderUnavailableError("Ollama installer automation is only configured for Windows.")

        command = [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://ollama.com/install.ps1 | iex",
        ]
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=max(60, int(self._settings.runtime_install_timeout_seconds)),
        )
        if completed.returncode != 0:
            output = (completed.stderr or completed.stdout or "").strip()
            raise ProviderUnavailableError(output or "Ollama installer failed.")
        if resolve_ollama_executable() is None:
            return RuntimeInstallationStatus.WAITING_FOR_USER
        return RuntimeInstallationStatus.SUCCEEDED


class OllamaModelInstaller:
    kind = RuntimeRequirementKind.OLLAMA_MODEL
    provider = "ollama"

    def __init__(self, provider: object) -> None:
        self._provider = provider
        self.model = str(getattr(provider, "model", "gemma4:12b"))
        self.provider = str(getattr(provider, "provider", "ollama"))

    def requirement(self) -> RuntimeRequirementSnapshot:
        if not callable(getattr(self._provider, "pull_model", None)):
            return RuntimeRequirementSnapshot(
                kind=self.kind,
                label="Ollama model",
                available=False,
                detail="Configured LLM provider does not support model downloads.",
                unavailable_reason="unsupported_provider",
                version=self.model,
            )
        health = self._provider.health() if hasattr(self._provider, "health") else None
        unavailable_reason = getattr(health, "unavailable_reason", None)
        available = bool(getattr(health, "available", False))
        detail = str(getattr(health, "detail", "Model health is unavailable."))
        if not available and unavailable_reason is None and "model" in detail.lower():
            unavailable_reason = "model_missing"
        return RuntimeRequirementSnapshot(
            kind=self.kind,
            label="Ollama model",
            available=available,
            detail=detail,
            unavailable_reason=unavailable_reason,
            version=self.model,
        )

    def validate_installable(self) -> None:
        if not callable(getattr(self._provider, "pull_model", None)):
            raise ProviderUnavailableError(
                "Configured LLM provider does not support model downloads."
            )

    def install(self, progress: Callable[[RuntimeInstallProgress], None]) -> RuntimeInstallationStatus:
        pull = getattr(self._provider, "pull_model", None)
        if not callable(pull):
            raise ProviderUnavailableError(
                "Configured LLM provider does not support model downloads."
            )

        def record_model_progress(model_progress: ModelPullProgress) -> None:
            progress(
                RuntimeInstallProgress(
                    detail=model_progress.status or "model download running",
                    completed=model_progress.completed,
                    total=model_progress.total,
                )
            )

        try:
            pull(record_model_progress)
        except Exception as exc:
            raise ProviderUnavailableError(f"Ollama unavailable: {exc}") from exc
        return RuntimeInstallationStatus.SUCCEEDED


class PaddleOcrRuntimeInstaller:
    kind = RuntimeRequirementKind.PADDLE_OCR
    provider = "paddle"
    model = "paddleocr"

    def __init__(self, settings: Settings, provider: OCRProvider) -> None:
        self._settings = settings
        self._provider = provider

    def requirement(self) -> RuntimeRequirementSnapshot:
        health = self._provider.health()
        return RuntimeRequirementSnapshot(
            kind=self.kind,
            label="PaddleOCR runtime",
            available=health.available,
            detail=health.detail,
            unavailable_reason=health.unavailable_reason,
            version=health.paddleocr_version,
            installed_path=health.model_cache_dir,
        )

    def install(self, progress: Callable[[RuntimeInstallProgress], None]) -> RuntimeInstallationStatus:
        manifest = load_ocr_runtime_source_manifest(self._settings)
        artifact = resolve_ocr_runtime_artifact(manifest)
        progress(RuntimeInstallProgress("Verifying PaddleOCR runtime artifact.", total=manifest.bytes))
        verify_file_hash(artifact, manifest.sha256, expected_bytes=manifest.bytes)

        runtime_dir = self._settings.resolved_ocr_runtime_dir
        runtime_dir.parent.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(dir=runtime_dir.parent) as temp_name:
            temp_dir = Path(temp_name)
            progress(RuntimeInstallProgress("Extracting PaddleOCR runtime artifact."))
            extract_zip_safely(artifact, temp_dir)
            entrypoint = temp_dir / manifest.entrypoint
            if not entrypoint.is_file():
                raise ProviderUnavailableError(
                    f"OCR runtime entrypoint was not found: {manifest.entrypoint}"
                )
            progress(RuntimeInstallProgress("Running PaddleOCR runtime self-test."))
            run_ocr_runtime_command(entrypoint, ["--ocr-self-test", "--device", "auto"])
            if runtime_dir.exists():
                shutil.rmtree(runtime_dir)
            shutil.move(str(temp_dir), runtime_dir)
        write_installed_ocr_manifest(runtime_dir, manifest)
        return RuntimeInstallationStatus.SUCCEEDED


@dataclass(frozen=True, slots=True)
class OcrRuntimeManifest:
    version: str
    target: str
    file_name: str
    sha256: str
    bytes: int
    entrypoint: str
    url: str | None = None
    base_dir: Path | None = None


def _utcnow() -> datetime:
    return datetime.now(UTC)


def resolve_ollama_executable() -> Path | None:
    configured = shutil.which("ollama")
    if configured:
        return Path(configured)
    if os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            candidate = Path(local_app_data) / "Programs" / "Ollama" / "ollama.exe"
            if candidate.is_file():
                return candidate
    return None


def load_ocr_runtime_source_manifest(settings: Settings) -> OcrRuntimeManifest:
    manifest_path = settings.ocr_runtime_manifest_path
    if manifest_path is None or not manifest_path.is_file():
        raise ProviderUnavailableError("PaddleOCR runtime manifest is not configured.")
    return parse_ocr_runtime_manifest(json.loads(manifest_path.read_text(encoding="utf-8")), manifest_path)


def parse_ocr_runtime_manifest(payload: dict[str, Any], manifest_path: Path) -> OcrRuntimeManifest:
    artifact = payload.get("artifact")
    if not isinstance(artifact, dict):
        raise ProviderUnavailableError("PaddleOCR runtime manifest is missing artifact metadata.")
    try:
        return OcrRuntimeManifest(
            version=str(payload["version"]),
            target=str(payload["target"]),
            file_name=str(artifact["file_name"]),
            sha256=str(artifact["sha256"]),
            bytes=int(artifact["bytes"]),
            entrypoint=str(payload["entrypoint"]),
            url=str(artifact["url"]) if artifact.get("url") else None,
            base_dir=manifest_path.parent,
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ProviderUnavailableError(
            f"PaddleOCR runtime manifest is invalid: {manifest_path}"
        ) from exc


def resolve_ocr_runtime_artifact(manifest: OcrRuntimeManifest) -> Path:
    candidates = [
        (manifest.base_dir / manifest.file_name) if manifest.base_dir is not None else None,
        Path(manifest.file_name),
        Path.cwd() / manifest.file_name,
        Path.home() / "Downloads" / manifest.file_name,
    ]
    for candidate in candidates:
        if candidate is not None and candidate.is_file():
            return candidate.resolve()
    if manifest.url:
        download_dir = Path(os.environ.get("TEMP", Path.cwd())) / "exam-prep-runtime-downloads"
        download_dir.mkdir(parents=True, exist_ok=True)
        target = download_dir / manifest.file_name
        urlretrieve(manifest.url, target)
        return target
    raise ProviderUnavailableError(
        f"PaddleOCR runtime artifact was not found: {manifest.file_name}"
    )


def verify_file_hash(path: Path, sha256: str, *, expected_bytes: int) -> None:
    digest = hashlib.sha256()
    total = 0
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            total += len(chunk)
            digest.update(chunk)
    if total != expected_bytes:
        raise ProviderUnavailableError(
            f"OCR runtime artifact size mismatch: expected {expected_bytes}, found {total}."
        )
    actual = digest.hexdigest()
    if actual.lower() != sha256.lower():
        raise ProviderUnavailableError("OCR runtime artifact checksum mismatch.")


def extract_zip_safely(artifact: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    with ZipFile(artifact) as archive:
        for member in archive.infolist():
            target = (destination / member.filename).resolve()
            if not str(target).startswith(str(destination.resolve())):
                raise ProviderUnavailableError("OCR runtime artifact contains an unsafe path.")
        archive.extractall(destination)


def write_installed_ocr_manifest(runtime_dir: Path, manifest: OcrRuntimeManifest) -> None:
    payload = {
        "schema_version": 1,
        "version": manifest.version,
        "target": manifest.target,
        "entrypoint": manifest.entrypoint,
        "artifact": {
            "file_name": manifest.file_name,
            "sha256": manifest.sha256,
            "bytes": manifest.bytes,
            "url": manifest.url,
        },
        "installed_at": _utcnow().isoformat(),
    }
    (runtime_dir / "runtime-manifest.json").write_text(
        json.dumps(payload, indent=2) + "\n",
        encoding="utf-8",
    )


def run_ocr_runtime_command(entrypoint: Path, args: list[str]) -> str:
    command: list[str]
    if entrypoint.suffix.lower() in {".cmd", ".bat"}:
        command = ["cmd.exe", "/C", str(entrypoint), *args]
    elif entrypoint.suffix.lower() == ".ps1":
        command = [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(entrypoint),
            *args,
        ]
    else:
        command = [str(entrypoint), *args]
    completed = subprocess.run(command, check=False, capture_output=True, text=True)
    if completed.returncode != 0:
        raise ProviderUnavailableError((completed.stderr or completed.stdout).strip())
    return completed.stdout
