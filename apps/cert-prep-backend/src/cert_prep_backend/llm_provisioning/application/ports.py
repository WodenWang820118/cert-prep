"""LLM provisioning boundaries for jobs, configured installers and background work."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from cert_prep_backend.llm_provisioning.domain.installation import (
    LLMInstallationJob,
    LLMInstallationTarget,
)
from cert_prep_contracts.llm_installation import (
    LLMInstallationStatus,
    LLMInstallProgress,
    LLMRequirementKind,
    LLMRequirementSnapshot,
)


class LLMInstaller(Protocol):
    """A lane's availability and installation; validation/cancellation are optional."""

    kind: LLMRequirementKind
    provider: str

    @property
    def model(self) -> str: ...

    def requirement(self) -> LLMRequirementSnapshot: ...

    def install(
        self, progress: Callable[[LLMInstallProgress], None]
    ) -> LLMInstallationStatus: ...


class LLMInstallationJobs(Protocol):
    """Aggregate storage; lock is reentrant and shared with the work adapter."""

    @property
    def lock(self) -> AbstractContextManager: ...

    @property
    def persistent(self) -> bool: ...

    def require(self, job_id: str) -> LLMInstallationJob: ...

    def find_active_or_create(
        self,
        target: LLMInstallationTarget,
        create_fn: Callable[[], LLMInstallationJob],
    ) -> tuple[LLMInstallationJob, bool]: ...

    def add(self, job: LLMInstallationJob) -> LLMInstallationJob: ...

    def save(self, job: LLMInstallationJob) -> None: ...

    def list_all(self) -> list[LLMInstallationJob]: ...

    def recover(self, now: datetime) -> list[LLMInstallationJob]: ...


class LLMInstallers(Protocol):
    """Ordered configured lanes, including lazy selection and explicit overrides."""

    @property
    def selected_model_kind(self) -> LLMRequirementKind: ...

    def ordered(self) -> Sequence[LLMInstaller]: ...

    def get(self, kind: LLMRequirementKind) -> LLMInstaller | None: ...


class LLMInstallationWorker(Protocol):
    def join(self, timeout: float) -> None: ...


class LLMInstallationWork(Protocol):
    """Technical worker/signal ownership, synchronized with the repository lock."""

    def prepare(self, job_id: str) -> None: ...

    def schedule(self, job_id: str, action: Callable[[], None]) -> None: ...

    def signal_cancellation(self, job_id: str) -> None: ...

    def cancellation_requested(self, job_id: str) -> bool: ...

    def workers(self) -> Sequence[LLMInstallationWorker]: ...

    def join_workers(self, workers: Sequence[LLMInstallationWorker]) -> None: ...


@dataclass(frozen=True)
class LLMInstallation:
    jobs: LLMInstallationJobs
    installers: LLMInstallers
    work: LLMInstallationWork
    clock: Callable[[], datetime]
    new_id: Callable[[], str]
