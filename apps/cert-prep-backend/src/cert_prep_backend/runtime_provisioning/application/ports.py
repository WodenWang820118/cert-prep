"""Runtime-owned boundaries for jobs, configured installers and background work."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from cert_prep_backend.runtime_provisioning.domain.installation import (
    RuntimeInstallationJob,
    RuntimeInstallationTarget,
)
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus,
    RuntimeInstallProgress,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
)


class RuntimeInstaller(Protocol):
    """A lane's availability and installation; validation/cancellation are optional."""

    kind: RuntimeRequirementKind
    provider: str

    @property
    def model(self) -> str: ...

    def requirement(self) -> RuntimeRequirementSnapshot: ...

    def install(
        self, progress: Callable[[RuntimeInstallProgress], None]
    ) -> RuntimeInstallationStatus: ...


class RuntimeInstallationJobs(Protocol):
    """Aggregate storage; lock is reentrant and shared with the work adapter."""

    @property
    def lock(self) -> AbstractContextManager: ...

    @property
    def persistent(self) -> bool: ...

    def require(self, job_id: str) -> RuntimeInstallationJob: ...

    def find_active_or_create(
        self,
        target: RuntimeInstallationTarget,
        create_fn: Callable[[], RuntimeInstallationJob],
    ) -> tuple[RuntimeInstallationJob, bool]: ...

    def add(self, job: RuntimeInstallationJob) -> RuntimeInstallationJob: ...

    def save(self, job: RuntimeInstallationJob) -> None: ...

    def list_all(self) -> list[RuntimeInstallationJob]: ...

    def recover(self, now: datetime) -> list[RuntimeInstallationJob]: ...


class RuntimeInstallers(Protocol):
    """Ordered configured lanes, including lazy selection and explicit overrides."""

    @property
    def selected_model_kind(self) -> RuntimeRequirementKind: ...

    def ordered(self) -> Sequence[RuntimeInstaller]: ...

    def get(self, kind: RuntimeRequirementKind) -> RuntimeInstaller | None: ...


class RuntimeInstallationWorker(Protocol):
    def join(self, timeout: float) -> None: ...


class RuntimeInstallationWork(Protocol):
    """Technical worker/signal ownership, synchronized with the repository lock."""

    def prepare(self, job_id: str) -> None: ...

    def schedule(self, job_id: str, action: Callable[[], None]) -> None: ...

    def signal_cancellation(self, job_id: str) -> None: ...

    def cancellation_requested(self, job_id: str) -> bool: ...

    def workers(self) -> Sequence[RuntimeInstallationWorker]: ...

    def join_workers(self, workers: Sequence[RuntimeInstallationWorker]) -> None: ...


@dataclass(frozen=True)
class RuntimeInstallation:
    jobs: RuntimeInstallationJobs
    installers: RuntimeInstallers
    work: RuntimeInstallationWork
    clock: Callable[[], datetime]
    new_id: Callable[[], str]
