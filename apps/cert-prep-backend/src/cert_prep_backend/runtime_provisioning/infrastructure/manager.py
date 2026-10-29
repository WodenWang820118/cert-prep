from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace
from threading import Event, Lock, RLock, Thread
from typing import Protocol
from uuid import uuid4

from cert_prep_backend.platform.config import Settings
from cert_prep_backend.ai_providers.application.ports import MachineInventory
from cert_prep_backend.ai_providers.application.use_cases import choose_ollama_profile
from cert_prep_backend.ai_providers.domain.provider import (
    RuntimeInstallationProvider,
    provider_capability,
)
from cert_prep_backend.runtime_provisioning.domain.installation import (
    RuntimeInstallationCanceledError,
    RuntimeInstallationJob,
    RuntimeInstallationPhase,
    RuntimeInstallationProgress,
    RuntimeInstallationTarget,
    TERMINAL_JOB_STATUSES,
)
from cert_prep_backend.runtime_provisioning.domain.models import (
    RuntimeInstallationSnapshot,
    utcnow,
)
from cert_prep_backend.runtime_provisioning.infrastructure.repository import (
    RuntimeInstallationJobRepository,
)
from cert_prep_backend.platform.database import Database
from cert_prep_backend.platform.errors import (
    OperationNotCancellableError,
    ProviderUnavailableError,
)
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


_RuntimeInstallationJob = RuntimeInstallationJob


class _Missing:
    pass


_MISSING = _Missing()


class _RuntimeInstallationCanceled(RuntimeInstallationCanceledError):
    pass


_MAX_RETAINED_JOBS = 100
_TERMINAL_JOB_STATUSES = set(TERMINAL_JOB_STATUSES)


class RuntimeInstallationManager:
    """Coordinates explicit, user-confirmed local runtime installations."""

    def __init__(
        self,
        *,
        settings: Settings,
        llm_provider: object,
        machine_inventory: MachineInventory,
        db: Database | None = None,
        async_jobs: bool = True,
        installers: list[RuntimeInstaller] | None = None,
    ) -> None:
        from cert_prep_backend.runtime_provisioning.infrastructure.installers import (
            LLMModelInstaller,
        )
        from cert_prep_ollama.installers import OllamaRuntimeInstaller

        self._settings = settings
        self._db = db
        self._async_jobs = async_jobs
        runtime_installation_provider = provider_capability(
            llm_provider,
            RuntimeInstallationProvider,
        )
        provider_runtime_kind = (
            runtime_installation_provider.runtime_requirement_kind
            if runtime_installation_provider is not None
            else None
        )
        llm_runtime_installers: list[RuntimeInstaller] = []
        if provider_runtime_kind == RuntimeRequirementKind.OLLAMA:
            llm_runtime_installers.append(
                OllamaRuntimeInstaller(
                    ollama_host=settings.ollama_host,
                    runtime_install_timeout_seconds=settings.runtime_install_timeout_seconds,
                )
            )
        llm_model_installer: RuntimeInstaller = LLMModelInstaller(llm_provider)
        if (
            provider_runtime_kind == RuntimeRequirementKind.OLLAMA
            and settings.ollama_profile_enabled
        ):
            llm_model_installer = _LazyOllamaProfileInstaller(settings, machine_inventory)
        elif provider_runtime_kind == RuntimeRequirementKind.OLLAMA:
            profile_selection = getattr(llm_provider, "profile_selection", None)
            if profile_selection is not None:
                from cert_prep_ollama.profile_installer import OllamaProfileInstaller

                llm_model_installer = OllamaProfileInstaller(
                    profile_selection.selected_profile,
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
                    for kind in (RuntimeRequirementKind.OLLAMA_MODEL,)
                    if kind in self._installers
                ),
                preferred_model_kind,
            )
        self._lock = RLock()
        self._cancellation_signals: dict[str, Event] = {}
        self._repository = RuntimeInstallationJobRepository(
            db=self._db,
            lock=self._lock,
            on_evict=self._remove_cancellation_signal,
        )
        self._job_threads: list[Thread] = []
        self._recover_persisted_jobs()

    @property
    def _jobs(self) -> dict[str, RuntimeInstallationJob]:
        return self._repository._jobs

    def _remove_cancellation_signal(self, job_id: str) -> None:
        self._cancellation_signals.pop(job_id, None)

    def requirements(self) -> list[RuntimeRequirementSnapshot]:
        """Return runtime requirements without starting installation work."""

        return [
            self._installers[kind].requirement()
            for kind in RuntimeRequirementKind
            if kind in self._installers
        ]

    def requirement(
        self, kind: RuntimeRequirementKind | str
    ) -> RuntimeRequirementSnapshot | None:
        """Return one local requirement without starting installation work."""

        installer = self._installers.get(RuntimeRequirementKind(kind))
        return None if installer is None else installer.requirement()

    def start_model_installation(self) -> RuntimeInstallationSnapshot:
        """Start the selected provider's model installation lane."""

        return self.start_installation(self._llm_model_requirement_kind)

    def start_installation(
        self,
        kind: RuntimeRequirementKind | str,
    ) -> RuntimeInstallationSnapshot:
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

        target = RuntimeInstallationTarget(
            kind=installer.kind,
            provider=installer.provider,
            model=installer.model,
        )

        def create_job() -> RuntimeInstallationJob:
            now = utcnow()
            job_id = str(uuid4())
            self._cancellation_signals[job_id] = Event()
            return RuntimeInstallationJob.queue(
                id=job_id,
                target=target,
                detail=f"{requirement.label} installation queued",
                total=requirement.bytes,
                now=now,
            )

        job, created = self._repository.find_active_or_create(target, create_job)
        if not created:
            return job.snapshot()

        if self._async_jobs:
            worker = Thread(
                target=self._run_installation,
                args=(job.id, installer),
                name=f"runtime-installation-{job.id[:8]}",
                daemon=True,
            )
            with self._lock:
                self._job_threads = [
                    thread for thread in self._job_threads if thread.is_alive()
                ]
                self._job_threads.append(worker)
            worker.start()
        else:
            self._run_installation(job.id, installer)
        return self.get_installation(job.id)

    def get_installation(self, job_id: str) -> RuntimeInstallationSnapshot:
        """Return the current job state, refreshing user-waiting jobs if possible."""

        job = self._repository.require(job_id)
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
            job = self._repository.require(job_id)
            if (
                job.status == RuntimeInstallationStatus.SUCCEEDED
                and job.commit_started_at is not None
            ):
                raise OperationNotCancellableError(
                    "Runtime installation committed and can no longer be canceled."
                )
            if job.status in _TERMINAL_JOB_STATUSES:
                return job.snapshot()
            if job.status == RuntimeInstallationStatus.CANCEL_REQUESTED:
                return job.snapshot()
            if not job.cancellable:
                raise OperationNotCancellableError(
                    "Runtime installation is committing and can no longer be canceled."
                )
            signal = self._cancellation_signals.get(job_id)
            if signal is not None:
                signal.set()
            now = utcnow()
            cancelled = job.cancel(now=now)
            self._repository.save(cancelled)
            installer = self._installers.get(cancelled.kind)
            candidate = getattr(installer, "cancel", None)
            if callable(candidate):
                cancel_callback = candidate
            snapshot = cancelled.snapshot()

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
                for job in self._repository.list_all()
                if not job.is_terminal
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
            job = self._repository.require(job_id)
            if job.status != RuntimeInstallationStatus.QUEUED:
                return
            now = utcnow()
            running = job.start(f"{installer.provider} installation running", now=now)
            self._repository.save(running)
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
                == RuntimeRequirementKind.OLLAMA_MODEL
                else snapshot.detail or f"{requirement.label} is ready"
            ),
            completed=(
                snapshot.completed
                if snapshot.completed is not None
                else requirement.bytes
            ),
            total=snapshot.total if snapshot.total is not None else requirement.bytes,
        )

    def _record_progress(self, job_id: str, progress: RuntimeInstallProgress) -> None:
        with self._lock:
            job = self._repository.require(job_id)
            signal = self._cancellation_signals.get(job_id)
            if (
                job.status == RuntimeInstallationStatus.CANCEL_REQUESTED
                or job.status == RuntimeInstallationStatus.CANCELED
                or (signal is not None and signal.is_set())
            ):
                raise _RuntimeInstallationCanceled("Runtime installation was canceled.")
            now = utcnow()
            progress_vo = RuntimeInstallationProgress.from_install_progress(progress)
            updated = job.record_progress(progress_vo, now=now)
            self._repository.save(updated)

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
            job = self._repository.require(job_id)
            if job.is_terminal:
                return
            target_status = status
            target_phase = phase
            target_cancellable = cancellable
            target_detail = detail
            target_completed = job.completed if completed is _MISSING else completed
            target_total = job.total if total is _MISSING else total
            target_error = (
                job.error
                if error is _MISSING
                else (None if error is None else str(error))
            )
            if (
                job.status == RuntimeInstallationStatus.CANCEL_REQUESTED
                and target_status
                not in {
                    RuntimeInstallationStatus.CANCEL_REQUESTED,
                    RuntimeInstallationStatus.CANCELED,
                }
            ):
                target_status = RuntimeInstallationStatus.CANCELED
                target_phase = "canceled"
                target_cancellable = False
                target_detail = "Runtime installation canceled"
                target_error = None
            now = utcnow()
            updated = replace(
                job,
                status=target_status,
                phase=RuntimeInstallationPhase.of(target_phase),
                cancellable=target_cancellable,
                detail=target_detail,
                completed=target_completed,  # type: ignore[arg-type]
                total=target_total,  # type: ignore[arg-type]
                error=target_error,
                updated_at=now,
            )
            self._repository.save(updated)

    def _active_job_for(self, kind: RuntimeRequirementKind) -> RuntimeInstallationJob | None:
        return self._repository.active_job_for(kind)

    def _installer(self, kind: RuntimeRequirementKind) -> RuntimeInstaller:
        installer = self._installers.get(kind)
        if installer is None:
            raise ProviderUnavailableError(f"No installer is configured for {kind.value}.")
        return installer

    def _completed_snapshot(
        self, installer: RuntimeInstaller, requirement: RuntimeRequirementSnapshot
    ) -> RuntimeInstallationSnapshot:
        now = utcnow()
        target = RuntimeInstallationTarget(
            kind=installer.kind,
            provider=installer.provider,
            model=installer.model,
        )
        job = RuntimeInstallationJob.create_succeeded(
            id=str(uuid4()),
            target=target,
            detail=f"{requirement.label} is ready",
            completed=requirement.bytes,
            total=requirement.bytes,
            now=now,
        )
        self._repository.add(job)
        return job.snapshot()

    def _recover_persisted_jobs(self) -> None:
        if self._db is None:
            return
        now = utcnow()
        recovered = self._repository.recover(now)
        for job in recovered:
            if not job.is_terminal:
                self._cancellation_signals[job.id] = Event()


class _LazyOllamaProfileInstaller:
    kind = RuntimeRequirementKind.OLLAMA_MODEL
    provider = "ollama"

    def __init__(self, settings: Settings, machine_inventory: MachineInventory) -> None:
        self._settings = settings
        self._machine_inventory = machine_inventory
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
                from cert_prep_ollama.profile_installer import OllamaProfileInstaller

                profile_selection = choose_ollama_profile(
                    self._settings,
                    self._machine_inventory.inventory,
                    provider_selected=True,
                )
                if profile_selection is None:
                    raise ProviderUnavailableError(
                        "Ollama profile selection is not available."
                    )
                self._installer = OllamaProfileInstaller(
                    profile_selection.selected_profile,
                    host=self._settings.ollama_host,
                    timeout_seconds=self._settings.ollama_timeout_seconds,
                    runtime_install_timeout_seconds=(
                        self._settings.runtime_install_timeout_seconds
                    ),
                )
            return self._installer
