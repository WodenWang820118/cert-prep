from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from threading import Event, Lock, Thread
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
from cert_prep_backend.persistence.database import Database
from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.api.errors import TermsAcceptanceRequiredError
from cert_prep_backend.core.exceptions import OperationNotCancellableError
from cert_prep_contracts.llm import FASTFLOWLM_RUNTIME_TRUST_POLICY
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
    phase: str
    cancellable: bool
    detail: str
    completed: int | None
    total: int | None
    created_at: datetime
    updated_at: datetime
    error: str | None = None
    cancellation: Event | None = None

    def snapshot(self) -> RuntimeInstallationSnapshot:
        return RuntimeInstallationSnapshot(
            id=self.id,
            kind=self.kind,
            provider=self.provider,
            model=self.model,
            status=self.status,
            phase=self.phase,
            cancellable=self.cancellable,
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


class _RuntimeInstallationCanceled(RuntimeError):
    pass


class RuntimeInstallationManager:
    """Coordinates explicit, user-confirmed local runtime installations."""

    def __init__(
        self,
        *,
        settings: Settings,
        llm_provider: object,
        ocr_provider: OCRProvider,
        db: Database | None = None,
        async_jobs: bool = True,
        installers: list[RuntimeInstaller] | None = None,
    ) -> None:
        from cert_prep_backend.domains.runtime_installations.installers import (
            LLMModelInstaller,
            WindowsMLOcrRuntimeInstaller,
            PaddleOcrRuntimeInstaller,
        )
        from cert_prep_backend.domains.runtime_installations.fastflowlm import (
            FastFlowLMRuntimeInstaller,
        )
        from cert_prep_backend.domains.source_documents.adapters.external_windowsml import (
            ExternalWindowsMLOCRProvider,
        )
        from cert_prep_ollama.installers import OllamaRuntimeInstaller
        from cert_prep_backend.domains.source_documents.adapters.external_paddle import (
            ExternalPaddleOCRProvider,
        )

        self._settings = settings
        self._db = db
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
        if str(getattr(llm_provider, "provider", "")) == "fastflowlm":
            llm_runtime_installers.append(FastFlowLMRuntimeInstaller(settings))
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
        preferred_model_kind = llm_model_installer.kind
        if preferred_model_kind in self._installers:
            self._llm_model_requirement_kind = preferred_model_kind
        else:
            self._llm_model_requirement_kind = next(
                (
                    kind
                    for kind in (
                        RuntimeRequirementKind.FASTFLOWLM_MODEL,
                        RuntimeRequirementKind.OLLAMA_MODEL,
                    )
                    if kind in self._installers
                ),
                preferred_model_kind,
            )
        self._jobs: dict[str, _RuntimeInstallationJob] = {}
        self._job_threads: list[Thread] = []
        self._lock = Lock()
        self._recover_persisted_jobs()

    def requirements(self) -> list[RuntimeRequirementSnapshot]:
        """Return runtime requirements without starting installation work."""

        return [
            self._installers[kind].requirement()
            for kind in RuntimeRequirementKind
            if kind in self._installers
        ]

    def start_model_installation(
        self,
        *,
        fastflowlm_terms_accepted_version: str | None = None,
    ) -> RuntimeInstallationSnapshot:
        """Start the selected provider's model installation lane."""

        return self.start_installation(
            self._llm_model_requirement_kind,
            fastflowlm_terms_accepted_version=fastflowlm_terms_accepted_version,
        )

    def start_installation(
        self,
        kind: RuntimeRequirementKind | str,
        *,
        fastflowlm_terms_accepted_version: str | None = None,
    ) -> RuntimeInstallationSnapshot:
        """Start or reuse an installation job for the requested requirement."""

        installer = self._installer(RuntimeRequirementKind(kind))
        requirement = installer.requirement()
        if requirement.available:
            return self._completed_snapshot(installer, requirement)
        accepted_terms_version = (
            fastflowlm_terms_accepted_version
            or self._settings.fastflowlm_terms_accepted_version
        )
        if installer.kind in {
            RuntimeRequirementKind.FASTFLOWLM,
            RuntimeRequirementKind.FASTFLOWLM_MODEL,
        } and (
            accepted_terms_version != FASTFLOWLM_RUNTIME_TRUST_POLICY.version
        ):
            raise TermsAcceptanceRequiredError(
                "FastFlowLM terms must be accepted for the pinned runtime version "
                f"{FASTFLOWLM_RUNTIME_TRUST_POLICY.version}."
            )
        authorize_terms = getattr(installer, "authorize_terms", None)
        if callable(authorize_terms) and accepted_terms_version is not None:
            authorize_terms(accepted_terms_version)
        validate = getattr(installer, "validate_installable", None)
        if callable(validate):
            try:
                validate()
            except TermsAcceptanceRequiredError:
                raise
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
                phase="queued",
                cancellable=True,
                detail=f"{requirement.label} installation queued",
                completed=None,
                total=requirement.bytes,
                created_at=now,
                updated_at=now,
                cancellation=Event(),
            )
            self._jobs[job.id] = job
            self._persist_job_locked(job)

        if self._async_jobs:
            worker = Thread(
                target=self._run_installation,
                args=(job.id, installer),
                name=f"runtime-installation-{job.id[:8]}",
                daemon=True,
            )
            with self._lock:
                self._job_threads = [thread for thread in self._job_threads if thread.is_alive()]
                self._job_threads.append(worker)
            worker.start()
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
                        phase="completed",
                        cancellable=False,
                        detail=f"{requirement.label} is ready",
                        completed=requirement.bytes,
                        total=requirement.bytes,
                        error=None,
                    )
                    return self.get_installation(job_id)
        return snapshot

    def cancel_installation(self, job_id: str) -> RuntimeInstallationSnapshot:
        """Request cancellation without allowing terminal state reversal."""

        cancel_callback = None
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise KeyError(job_id)
            if job.status in _TERMINAL_JOB_STATUSES:
                return job.snapshot()
            if job.status == RuntimeInstallationStatus.CANCEL_REQUESTED:
                return job.snapshot()
            if not job.cancellable:
                raise OperationNotCancellableError(
                    "Runtime installation is committing and can no longer be canceled."
                )
            if job.cancellation is not None:
                job.cancellation.set()
            if job.status == RuntimeInstallationStatus.QUEUED:
                job.status = RuntimeInstallationStatus.CANCELED
                job.phase = "canceled"
                job.cancellable = False
                job.detail = "Runtime installation canceled"
            else:
                job.status = RuntimeInstallationStatus.CANCEL_REQUESTED
                job.phase = "canceling"
                job.cancellable = False
                job.detail = "Runtime installation cancellation requested"
            job.updated_at = utcnow()
            self._persist_job_locked(job)
            installer = self._installers.get(job.kind)
            candidate = getattr(installer, "cancel", None)
            if callable(candidate):
                cancel_callback = candidate
            snapshot = job.snapshot()

        if cancel_callback is not None:
            try:
                cancel_callback()
            except Exception:
                # The durable cancellation state still prevents a late success commit.
                pass
        return snapshot

    def close(self) -> None:
        """Cancel manager-owned jobs and briefly join their worker threads."""

        with self._lock:
            job_ids = [
                job.id
                for job in self._jobs.values()
                if job.status not in _TERMINAL_JOB_STATUSES
            ]
            workers = list(self._job_threads)
        for job_id in job_ids:
            try:
                self.cancel_installation(job_id)
            except (KeyError, OperationNotCancellableError):
                continue
        for worker in workers:
            worker.join(timeout=1)

    def _run_installation(self, job_id: str, installer: RuntimeInstaller) -> None:
        with self._lock:
            job = self._jobs[job_id]
            if job.status != RuntimeInstallationStatus.QUEUED:
                return
            job.status = RuntimeInstallationStatus.RUNNING
            job.phase = "starting"
            job.cancellable = True
            job.detail = f"{installer.provider} installation running"
            job.updated_at = utcnow()
            self._persist_job_locked(job)
        try:
            status = installer.install(lambda progress: self._record_progress(job_id, progress))
        except _RuntimeInstallationCanceled:
            self._update_job(
                job_id,
                status=RuntimeInstallationStatus.CANCELED,
                phase="canceled",
                cancellable=False,
                detail="Runtime installation canceled",
                error=None,
            )
            return
        except Exception as exc:
            self._update_job(
                job_id,
                status=RuntimeInstallationStatus.FAILED,
                phase="failed",
                cancellable=False,
                detail=str(exc),
                error=str(exc),
            )
            return

        requirement = installer.requirement()
        if status == RuntimeInstallationStatus.WAITING_FOR_USER:
            self._update_job(
                job_id,
                status=status,
                phase="waiting_for_user",
                cancellable=True,
                detail=requirement.detail,
                completed=None,
                total=requirement.bytes,
            )
            return
        snapshot = self.get_installation(job_id)

        self._update_job(
            job_id,
            status=RuntimeInstallationStatus.SUCCEEDED,
            phase="completed",
            cancellable=False,
            detail=(
                "model download complete"
                if installer.kind
                in {
                    RuntimeRequirementKind.OLLAMA_MODEL,
                    RuntimeRequirementKind.FASTFLOWLM_MODEL,
                }
                else snapshot.detail or f"{requirement.label} is ready"
            ),
            completed=snapshot.completed if snapshot.completed is not None else requirement.bytes,
            total=snapshot.total if snapshot.total is not None else requirement.bytes,
        )

    def _record_progress(self, job_id: str, progress: RuntimeInstallProgress) -> None:
        with self._lock:
            job = self._jobs[job_id]
            if (
                job.status == RuntimeInstallationStatus.CANCEL_REQUESTED
                or job.status == RuntimeInstallationStatus.CANCELED
                or (job.cancellation is not None and job.cancellation.is_set())
            ):
                raise _RuntimeInstallationCanceled("Runtime installation was canceled.")
            job.status = RuntimeInstallationStatus.RUNNING
            job.phase = progress.phase or "installing"
            job.cancellable = (
                progress.cancellable
                if progress.cancellable is not None
                else True
            )
            job.detail = progress.detail
            job.completed = progress.completed
            job.total = progress.total
            job.updated_at = utcnow()
            self._persist_job_locked(job)

    def _update_job(
        self,
        job_id: str,
        *,
        status: RuntimeInstallationStatus,
        phase: str,
        cancellable: bool,
        detail: str,
        completed: int | None | object = _MISSING,
        total: int | None | object = _MISSING,
        error: str | None | object = _MISSING,
    ) -> None:
        with self._lock:
            job = self._jobs[job_id]
            if job.status in _TERMINAL_JOB_STATUSES:
                return
            if (
                job.status == RuntimeInstallationStatus.CANCEL_REQUESTED
                and status
                not in {
                    RuntimeInstallationStatus.CANCEL_REQUESTED,
                    RuntimeInstallationStatus.CANCELED,
                }
            ):
                status = RuntimeInstallationStatus.CANCELED
                phase = "canceled"
                cancellable = False
                detail = "Runtime installation canceled"
                error = None
            job.status = status
            job.phase = phase
            job.cancellable = cancellable
            job.detail = detail
            if completed is not _MISSING:
                job.completed = completed  # type: ignore[assignment]
            if total is not _MISSING:
                job.total = total  # type: ignore[assignment]
            if error is not _MISSING:
                job.error = error  # type: ignore[assignment]
            job.updated_at = utcnow()
            self._persist_job_locked(job)
            if job.status in _TERMINAL_JOB_STATUSES:
                self._evict_terminal_jobs_locked()

    def _active_job_for(self, kind: RuntimeRequirementKind) -> _RuntimeInstallationJob | None:
        for job in self._jobs.values():
            if job.kind == kind and job.status in {
                RuntimeInstallationStatus.QUEUED,
                RuntimeInstallationStatus.RUNNING,
                RuntimeInstallationStatus.CANCEL_REQUESTED,
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
        now = utcnow()
        job = _RuntimeInstallationJob(
            id=str(uuid4()),
            kind=installer.kind,
            provider=installer.provider,
            model=installer.model,
            status=RuntimeInstallationStatus.SUCCEEDED,
            phase="completed",
            cancellable=False,
            detail=f"{requirement.label} is ready",
            completed=requirement.bytes,
            total=requirement.bytes,
            created_at=now,
            updated_at=now,
        )
        with self._lock:
            self._jobs[job.id] = job
            self._persist_job_locked(job)
            self._evict_terminal_jobs_locked()
        return job.snapshot()

    def _recover_persisted_jobs(self) -> None:
        if self._db is None:
            return
        now = utcnow().isoformat()
        with self._db.connect() as connection:
            connection.execute(
                """
                UPDATE runtime_installation_jobs
                SET status = 'failed', phase = 'interrupted', cancellable = 0,
                    detail = 'Runtime installation was interrupted by an app restart.',
                    error = 'Runtime installation was interrupted by an app restart.',
                    updated_at = ?
                WHERE status IN ('queued', 'running')
                """,
                (now,),
            )
            connection.execute(
                """
                UPDATE runtime_installation_jobs
                SET status = 'canceled', phase = 'canceled', cancellable = 0,
                    detail = 'Runtime installation cancellation completed after restart.',
                    error = NULL, updated_at = ?
                WHERE status = 'cancel_requested'
                """,
                (now,),
            )
            rows = connection.execute(
                """
                SELECT * FROM runtime_installation_jobs
                ORDER BY updated_at DESC, created_at DESC, id DESC
                LIMIT ?
                """,
                (_MAX_RETAINED_JOBS,),
            ).fetchall()
        for row in reversed(rows):
            status = RuntimeInstallationStatus(str(row["status"]))
            job = _RuntimeInstallationJob(
                id=str(row["id"]),
                kind=RuntimeRequirementKind(str(row["kind"])),
                provider=str(row["provider"]),
                model=str(row["model"]),
                status=status,
                phase=str(row["phase"]),
                cancellable=bool(row["cancellable"]),
                detail=str(row["detail"]),
                completed=row["completed"],
                total=row["total"],
                created_at=datetime.fromisoformat(str(row["created_at"])),
                updated_at=datetime.fromisoformat(str(row["updated_at"])),
                error=row["error"],
                cancellation=(
                    Event() if status not in _TERMINAL_JOB_STATUSES else None
                ),
            )
            self._jobs[job.id] = job

    def _persist_job_locked(self, job: _RuntimeInstallationJob) -> None:
        if self._db is None:
            return
        with self._db.connect() as connection:
            connection.execute(
                """
                INSERT INTO runtime_installation_jobs(
                    id, kind, provider, model, status, phase, cancellable,
                    detail, completed, total, error, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    status = excluded.status,
                    phase = excluded.phase,
                    cancellable = excluded.cancellable,
                    detail = excluded.detail,
                    completed = excluded.completed,
                    total = excluded.total,
                    error = excluded.error,
                    updated_at = excluded.updated_at
                """,
                (
                    job.id,
                    job.kind.value,
                    job.provider,
                    job.model,
                    job.status.value,
                    job.phase,
                    int(job.cancellable),
                    job.detail,
                    job.completed,
                    job.total,
                    job.error,
                    job.created_at.isoformat(),
                    job.updated_at.isoformat(),
                ),
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
    RuntimeInstallationStatus.CANCELED,
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
