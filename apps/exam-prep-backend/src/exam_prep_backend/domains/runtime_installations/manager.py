from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from threading import Lock, Thread
from typing import Protocol
from uuid import uuid4

from exam_prep_backend.config import Settings
from exam_prep_backend.domains.runtime_installations.models import (
    RuntimeInstallationSnapshot,
    RuntimeInstallationStatus,
    RuntimeInstallProgress,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
    utcnow,
)
from exam_prep_backend.domains.source_documents.ocr import OCRProvider
from exam_prep_backend.errors import ProviderUnavailableError


class RuntimeInstaller(Protocol):
    """Provider boundary for installing one local runtime requirement."""

    kind: RuntimeRequirementKind
    provider: str
    model: str

    def requirement(self) -> RuntimeRequirementSnapshot:
        """Return the current read-only availability state."""
        pass

    def install(self, progress: Callable[[RuntimeInstallProgress], None]) -> RuntimeInstallationStatus:
        """Install the requirement and emit progress updates."""
        pass


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
        from exam_prep_backend.domains.runtime_installations.installers import (
            WindowsMLOcrRuntimeInstaller,
            OllamaModelInstaller,
            OllamaRuntimeInstaller,
            PaddleOcrRuntimeInstaller,
        )
        from exam_prep_backend.domains.source_documents.adapters.external_windowsml import (
            ExternalWindowsMLOCRProvider,
        )
        from exam_prep_backend.domains.source_documents.adapters.external_paddle import (
            ExternalPaddleOCRProvider,
        )

        self._settings = settings
        self._async_jobs = async_jobs
        self._installers = {
            installer.kind: installer
            for installer in (
                installers
                or [
                    OllamaRuntimeInstaller(settings),
                    OllamaModelInstaller(llm_provider),
                    PaddleOcrRuntimeInstaller(
                        settings,
                        (
                            ocr_provider
                            if getattr(ocr_provider, "provider", None) == "paddle"
                            else ExternalPaddleOCRProvider(settings)
                        ),
                    ),
                    WindowsMLOcrRuntimeInstaller(
                        settings,
                        (
                            ocr_provider
                            if getattr(ocr_provider, "provider", None) == "windowsml"
                            else ExternalWindowsMLOCRProvider(settings)
                        ),
                    ),
                ]
            )
        }
        self._jobs: dict[str, _RuntimeInstallationJob] = {}
        self._lock = Lock()

    def requirements(self) -> list[RuntimeRequirementSnapshot]:
        """Return runtime requirements without starting installation work."""

        return [
            self._installers[kind].requirement()
            for kind in RuntimeRequirementKind
            if kind in self._installers
        ]

    def start_installation(self, kind: RuntimeRequirementKind | str) -> RuntimeInstallationSnapshot:
        """Start or reuse an installation job for the requested requirement."""

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

            now = utcnow()
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
        """Return the current job state, refreshing user-waiting jobs if possible."""

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
            job.updated_at = utcnow()

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
        now = utcnow().isoformat()
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
