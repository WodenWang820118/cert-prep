"""Application orchestration for explicit local runtime installations."""

from __future__ import annotations

from dataclasses import replace

from cert_prep_backend.platform.errors import OperationNotCancellableError, ProviderUnavailableError
from cert_prep_backend.runtime_provisioning.application.ports import (
    RuntimeInstallation,
    RuntimeInstaller,
)
from cert_prep_backend.runtime_provisioning.domain.installation import (
    TERMINAL_JOB_STATUSES,
    RuntimeInstallationCanceledError,
    RuntimeInstallationJob,
    RuntimeInstallationPhase,
    RuntimeInstallationProgress,
    RuntimeInstallationTarget,
)
from cert_prep_backend.runtime_provisioning.domain.models import RuntimeInstallationSnapshot
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus,
    RuntimeInstallProgress,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
)

__all__ = [
    "list_runtime_requirements",
    "start_runtime_installation",
    "download_selected_model",
    "view_runtime_installation",
    "cancel_runtime_installation",
    "perform_runtime_installation",
    "recover_runtime_installations",
    "stop_runtime_installations",
]

_MISSING = object()


class _RuntimeInstallationCanceled(RuntimeInstallationCanceledError):
    """Internal progress interruption, distinct from an installer's own failures."""


def list_runtime_requirements(runtime: RuntimeInstallation) -> list[RuntimeRequirementSnapshot]:
    """Evaluate the configured requirements in requirement-kind order."""
    return [installer.requirement() for installer in runtime.installers.ordered()]


def download_selected_model(runtime: RuntimeInstallation) -> RuntimeInstallationSnapshot:
    """Install the selected provider's model lane."""
    return start_runtime_installation(runtime, runtime.installers.selected_model_kind)


def start_runtime_installation(
    runtime: RuntimeInstallation,
    kind: RuntimeRequirementKind | str,
) -> RuntimeInstallationSnapshot:
    """Start or reuse an installation job for the requested requirement."""

    installer = _installer(runtime, RuntimeRequirementKind(kind))
    requirement = installer.requirement()
    if requirement.available:
        return _completed_snapshot(runtime, installer, requirement)
    validate = getattr(installer, "validate_installable", None)
    if callable(validate):
        try:
            validate()
        except ProviderUnavailableError:
            raise
        except Exception as exc:
            raise ProviderUnavailableError(str(exc)) from exc

    target = RuntimeInstallationTarget(
        kind=installer.kind,
        provider=installer.provider,
        model=installer.model,
    )

    def create_job() -> RuntimeInstallationJob:
        now = runtime.clock()
        job_id = runtime.new_id()
        runtime.work.prepare(job_id)
        return RuntimeInstallationJob.queue(
            id=job_id,
            target=target,
            detail=f"{requirement.label} installation queued",
            total=requirement.bytes,
            now=now,
        )

    job, created = runtime.jobs.find_active_or_create(target, create_job)
    if not created:
        return job.snapshot()

    runtime.work.schedule(
        job.id, lambda: perform_runtime_installation(runtime, job.id, installer)
    )
    return view_runtime_installation(runtime, job.id)


def view_runtime_installation(runtime: RuntimeInstallation, job_id: str) -> RuntimeInstallationSnapshot:
    """Return the current job state, refreshing user-waiting jobs if possible."""

    job = runtime.jobs.require(job_id)
    snapshot = job.snapshot()

    if snapshot.status == RuntimeInstallationStatus.WAITING_FOR_USER:
        installer = runtime.installers.get(snapshot.kind)
        if installer is not None:
            requirement = installer.requirement()
            if requirement.available:
                _update_job(
                    runtime,
                    job_id,
                    status=RuntimeInstallationStatus.SUCCEEDED,
                    phase="completed",
                    cancellable=False,
                    detail=f"{requirement.label} is ready",
                    completed=requirement.bytes,
                    total=requirement.bytes,
                    error=None,
                )
                return view_runtime_installation(runtime, job_id)
    return snapshot


def cancel_runtime_installation(runtime: RuntimeInstallation, job_id: str) -> RuntimeInstallationSnapshot:
    """Request cancellation without allowing terminal state reversal."""

    cancel_callback = None
    with runtime.jobs.lock:
        job = runtime.jobs.require(job_id)
        if (
            job.status == RuntimeInstallationStatus.SUCCEEDED
            and job.commit_started_at is not None
        ):
            raise OperationNotCancellableError(
                "Runtime installation committed and can no longer be canceled."
            )
        if job.status in TERMINAL_JOB_STATUSES:
            return job.snapshot()
        if job.status == RuntimeInstallationStatus.CANCEL_REQUESTED:
            return job.snapshot()
        if not job.cancellable:
            raise OperationNotCancellableError(
                "Runtime installation is committing and can no longer be canceled."
            )
        runtime.work.signal_cancellation(job_id)
        now = runtime.clock()
        cancelled = job.cancel(now=now)
        runtime.jobs.save(cancelled)
        installer = runtime.installers.get(cancelled.kind)
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


def stop_runtime_installations(runtime: RuntimeInstallation) -> None:
    """Request cancellation of active jobs, then join the captured workers."""

    with runtime.jobs.lock:
        job_ids = [
            job.id
            for job in runtime.jobs.list_all()
            if not job.is_terminal
        ]
        workers = runtime.work.workers()
    for job_id in job_ids:
        try:
            cancel_runtime_installation(runtime, job_id)
        except (KeyError, OperationNotCancellableError):
            continue
    runtime.work.join_workers(workers)


def perform_runtime_installation(
    runtime: RuntimeInstallation, job_id: str, installer: RuntimeInstaller
) -> None:
    """Execute queued work, preserving progress, cancellation and finalization ordering."""
    with runtime.jobs.lock:
        job = runtime.jobs.require(job_id)
        if job.status != RuntimeInstallationStatus.QUEUED:
            return
        now = runtime.clock()
        running = job.start(f"{installer.provider} installation running", now=now)
        runtime.jobs.save(running)
    try:
        status = installer.install(lambda progress: _record_progress(runtime, job_id, progress))
    except _RuntimeInstallationCanceled:
        _update_job(
            runtime,
            job_id,
            status=RuntimeInstallationStatus.CANCELED,
            phase="canceled",
            cancellable=False,
            detail="Runtime installation canceled",
            error=None,
        )
        return
    except Exception as exc:
        _update_job(
            runtime,
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
        _update_job(
            runtime,
            job_id,
            status=status,
            phase="waiting_for_user",
            cancellable=True,
            detail=requirement.detail,
            completed=None,
            total=requirement.bytes,
        )
        return
    snapshot = view_runtime_installation(runtime, job_id)

    _update_job(
        runtime,
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


def _record_progress(runtime: RuntimeInstallation, job_id: str, progress: RuntimeInstallProgress) -> None:
    with runtime.jobs.lock:
        job = runtime.jobs.require(job_id)
        if (
            job.status == RuntimeInstallationStatus.CANCEL_REQUESTED
            or job.status == RuntimeInstallationStatus.CANCELED
            or runtime.work.cancellation_requested(job_id)
        ):
            raise _RuntimeInstallationCanceled("Runtime installation was canceled.")
        now = runtime.clock()
        progress_vo = RuntimeInstallationProgress.from_install_progress(progress)
        updated = job.record_progress(progress_vo, now=now)
        runtime.jobs.save(updated)


def _update_job(
    runtime: RuntimeInstallation,
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
    with runtime.jobs.lock:
        job = runtime.jobs.require(job_id)
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
        now = runtime.clock()
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
        runtime.jobs.save(updated)


def _installer(runtime: RuntimeInstallation, kind: RuntimeRequirementKind) -> RuntimeInstaller:
    installer = runtime.installers.get(kind)
    if installer is None:
        raise ProviderUnavailableError(f"No installer is configured for {kind.value}.")
    return installer


def _completed_snapshot(
    runtime: RuntimeInstallation, installer: RuntimeInstaller, requirement: RuntimeRequirementSnapshot
) -> RuntimeInstallationSnapshot:
    now = runtime.clock()
    target = RuntimeInstallationTarget(
        kind=installer.kind,
        provider=installer.provider,
        model=installer.model,
    )
    job = RuntimeInstallationJob.create_succeeded(
        id=runtime.new_id(),
        target=target,
        detail=f"{requirement.label} is ready",
        completed=requirement.bytes,
        total=requirement.bytes,
        now=now,
    )
    runtime.jobs.add(job)
    return job.snapshot()


def recover_runtime_installations(runtime: RuntimeInstallation) -> None:
    """Recover persisted jobs atomically and restore signals for retained active jobs."""
    if not runtime.jobs.persistent:
        return
    now = runtime.clock()
    recovered = runtime.jobs.recover(now)
    for job in recovered:
        if not job.is_terminal:
            runtime.work.prepare(job.id)
