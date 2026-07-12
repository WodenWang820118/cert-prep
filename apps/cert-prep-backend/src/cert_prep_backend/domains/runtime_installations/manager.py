from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from threading import Lock, Thread
from typing import Protocol
from uuid import uuid4

from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.mock_exams.ports import (
    OllamaRuntimeInstallationProvider,
    provider_capability,
)
from cert_prep_backend.domains.runtime_installations.models import (
    RuntimeInstallationSnapshot,
    utcnow,
)
from cert_prep_backend.domains.source_documents.ocr import OCRProvider
from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus,
    RuntimeInstallProgress,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
)
from cert_prep_ollama.exceptions import ProviderUnavailableError as OllamaProviderUnavailableError


class RuntimeInstaller(Protocol):
    """Provider boundary for installing one local runtime requirement."""

    kind: RuntimeRequirementKind
    provider: str
    model: str

    def requirement(self) -> RuntimeRequirementSnapshot:
        """Return the current read-only availability state."""
        pass

    def install(
        self, progress: Callable[[RuntimeInstallProgress], None]
    ) -> RuntimeInstallationStatus:
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
        from cert_prep_backend.domains.runtime_installations.installers import (
            LLMModelInstaller,
            WindowsMLOcrRuntimeInstaller,
            PaddleOcrRuntimeInstaller,
        )
        from cert_prep_backend.domains.source_documents.adapters.external_windowsml import (
            ExternalWindowsMLOCRProvider,
        )
        from cert_prep_ollama.installers import OllamaRuntimeInstaller
        from cert_prep_backend.domains.source_documents.adapters.external_paddle import (
            ExternalPaddleOCRProvider,
        )

        self._async_jobs = async_jobs
        ollama_runtime_provider = provider_capability(
            llm_provider,
            OllamaRuntimeInstallationProvider,
        )
        supports_ollama_runtime = bool(
            ollama_runtime_provider
            and ollama_runtime_provider.supports_ollama_runtime_installation
        )
        llm_runtime_installers: list[RuntimeInstaller] = []
        if supports_ollama_runtime:
            llm_runtime_installers.append(
                OllamaRuntimeInstaller(
                    ollama_host=settings.ollama_host,
                    runtime_install_timeout_seconds=settings.runtime_install_timeout_seconds,
                )
            )
        llm_model_installer: RuntimeInstaller = LLMModelInstaller(llm_provider)
        if (
            supports_ollama_runtime
            and settings.ollama_profile_enabled
        ):
            llm_model_installer = _LazyOllamaProfileInstaller(settings)
        elif supports_ollama_runtime:
            profile_selection = getattr(llm_provider, "profile_selection", None)
            if profile_selection is not None:
                from cert_prep_ollama.profile_installer import OllamaProfileInstaller

                llm_model_installer = OllamaProfileInstaller(
                    profile_selection.selected_profile,
                    fallback_profiles=profile_selection.fallback_profiles,
                    host=settings.ollama_host,
                    timeout_seconds=settings.ollama_timeout_seconds,
                    runtime_install_timeout_seconds=settings.runtime_install_timeout_seconds,
                )
        self._installers = {
            installer.kind: installer
            for installer in (
                installers
                or [
                    *llm_runtime_installers,
                    llm_model_installer,
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

    def start_model_installation(self) -> RuntimeInstallationSnapshot:
        """Start the selected provider's model installation job."""

        for kind in (
            RuntimeRequirementKind.FASTFLOWLM_MODEL,
            RuntimeRequirementKind.OLLAMA_MODEL,
        ):
            if kind in self._installers:
                return self.start_installation(kind)
        raise ProviderUnavailableError("No model installer is configured.")

    def start_installation(self, kind: RuntimeRequirementKind | str) -> RuntimeInstallationSnapshot:
        """Start or reuse an installation job for the requested requirement."""

        installer = self._installer(RuntimeRequirementKind(kind))
        requirement = installer.requirement()
        if requirement.available:
            return self._completed_snapshot(installer, requirement)
        validate = getattr(installer, "validate_installable", None)
        if callable(validate):
            try:
                validate()
            except ProviderUnavailableError:
                raise
            except OllamaProviderUnavailableError as exc:
                raise ProviderUnavailableError(str(exc)) from exc
            except Exception as exc:
                raise ProviderUnavailableError(str(exc)) from exc

        with self._lock:
            self._evict_terminal_jobs_locked()
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
            if job.status in _TERMINAL_JOB_STATUSES:
                self._evict_terminal_jobs_locked()

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

    def _evict_terminal_jobs_locked(self) -> None:
        if len(self._jobs) <= _MAX_RETAINED_JOBS:
            return
        terminal_jobs = sorted(
            (
                job
                for job in self._jobs.values()
                if job.status in _TERMINAL_JOB_STATUSES
            ),
            key=lambda job: job.updated_at,
        )
        for job in terminal_jobs:
            if len(self._jobs) <= _MAX_RETAINED_JOBS:
                break
            self._jobs.pop(job.id, None)


_MAX_RETAINED_JOBS = 100
_TERMINAL_JOB_STATUSES = {
    RuntimeInstallationStatus.SUCCEEDED,
    RuntimeInstallationStatus.FAILED,
}


class _LazyOllamaProfileInstaller:
    kind = RuntimeRequirementKind.OLLAMA_MODEL
    provider = "ollama"

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._lock = Lock()
        self._installer: RuntimeInstaller | None = None

    @property
    def model(self) -> str:
        installer = self._installer
        if installer is not None:
            return installer.model
        return f"ollama-profile:{self._settings.ollama_profile_id}"

    def requirement(self) -> RuntimeRequirementSnapshot:
        return self._delegate().requirement()

    def validate_installable(self) -> None:
        validate = getattr(self._delegate(), "validate_installable", None)
        if callable(validate):
            validate()

    def install(
        self,
        progress: Callable[[RuntimeInstallProgress], None],
    ) -> RuntimeInstallationStatus:
        return self._delegate().install(progress)

    def _delegate(self) -> RuntimeInstaller:
        installer = self._installer
        if installer is not None:
            return installer
        with self._lock:
            if self._installer is None:
                from cert_prep_backend.domains.mock_exams.ollama_profiles import (
                    ollama_profile_selection_from_settings,
                )
                from cert_prep_ollama.profile_installer import OllamaProfileInstaller

                profile_selection = ollama_profile_selection_from_settings(
                    self._settings,
                    provider_selected=True,
                )
                if profile_selection is None:
                    raise ProviderUnavailableError(
                        "Ollama profile selection is not available."
                    )
                self._installer = OllamaProfileInstaller(
                    profile_selection.selected_profile,
                    fallback_profiles=profile_selection.fallback_profiles,
                    host=self._settings.ollama_host,
                    timeout_seconds=self._settings.ollama_timeout_seconds,
                    runtime_install_timeout_seconds=(
                        self._settings.runtime_install_timeout_seconds
                    ),
                )
            return self._installer
