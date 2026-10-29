"""The RuntimeInstallationJob aggregate and value objects."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from typing import ClassVar

from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus,
    RuntimeInstallProgress,
    RuntimeRequirementKind,
)
from cert_prep_backend.platform.errors import OperationNotCancellableError
from cert_prep_backend.runtime_provisioning.domain.models import RuntimeInstallationSnapshot

__all__ = [
    "ACTIVE_JOB_STATUSES",
    "TERMINAL_JOB_STATUSES",
    "RuntimeInstallationCanceledError",
    "RuntimeInstallationJob",
    "RuntimeInstallationPhase",
    "RuntimeInstallationProgress",
    "RuntimeInstallationTarget",
    "UNSET",
]


class _Unset:
    def __repr__(self) -> str:
        return "UNSET"

    def __bool__(self) -> bool:
        return False


UNSET = _Unset()


class RuntimeInstallationCanceledError(RuntimeError):
    """Raised when an installation job transition is rejected due to cancellation."""


ACTIVE_JOB_STATUSES: frozenset[RuntimeInstallationStatus] = frozenset(
    {
        RuntimeInstallationStatus.QUEUED,
        RuntimeInstallationStatus.RUNNING,
        RuntimeInstallationStatus.CANCEL_REQUESTED,
        RuntimeInstallationStatus.WAITING_FOR_USER,
    }
)

TERMINAL_JOB_STATUSES: frozenset[RuntimeInstallationStatus] = frozenset(
    {
        RuntimeInstallationStatus.SUCCEEDED,
        RuntimeInstallationStatus.FAILED,
        RuntimeInstallationStatus.CANCELED,
    }
)


@dataclass(frozen=True, slots=True)
class RuntimeInstallationTarget:
    """The requirement kind, provider, and model being installed."""

    kind: RuntimeRequirementKind
    provider: str
    model: str

    def __post_init__(self) -> None:
        if not isinstance(self.kind, RuntimeRequirementKind):
            object.__setattr__(self, "kind", RuntimeRequirementKind(self.kind))
        if not isinstance(self.provider, str):
            object.__setattr__(self, "provider", str(self.provider))
        if not isinstance(self.model, str):
            object.__setattr__(self, "model", str(self.model))


@dataclass(frozen=True, slots=True)
class RuntimeInstallationPhase:
    """The technical phase of an installation, accepting known and unknown phases."""

    value: str

    QUEUED: ClassVar[str] = "queued"
    STARTING: ClassVar[str] = "starting"
    INSTALLING: ClassVar[str] = "installing"
    COMMITTING: ClassVar[str] = "committing"
    WAITING_FOR_USER: ClassVar[str] = "waiting_for_user"
    COMPLETED: ClassVar[str] = "completed"
    CANCELING: ClassVar[str] = "canceling"
    CANCELED: ClassVar[str] = "canceled"
    FAILED: ClassVar[str] = "failed"
    INTERRUPTED: ClassVar[str] = "interrupted"

    def __post_init__(self) -> None:
        if not isinstance(self.value, str):
            object.__setattr__(self, "value", str(self.value))

    def __str__(self) -> str:
        return self.value

    def __eq__(self, other: object) -> bool:
        if isinstance(other, RuntimeInstallationPhase):
            return self.value == other.value
        if isinstance(other, str):
            return self.value == other
        return False

    def __hash__(self) -> int:
        return hash(self.value)

    @classmethod
    def of(cls, value: RuntimeInstallationPhase | str) -> RuntimeInstallationPhase:
        if isinstance(value, RuntimeInstallationPhase):
            return value
        return cls(str(value))


@dataclass(frozen=True, slots=True)
class RuntimeInstallationProgress:
    """Progress update for an installation job; distinguishes omitted updates from explicit null."""

    detail: str | None = None
    completed: int | None | _Unset = UNSET
    total: int | None | _Unset = UNSET
    phase: RuntimeInstallationPhase | str | None | _Unset = UNSET
    cancellable: bool | None | _Unset = UNSET

    def __init__(
        self,
        detail: str | None = None,
        completed: int | None | _Unset = UNSET,
        total: int | None | _Unset = UNSET,
        phase: RuntimeInstallationPhase | str | None | _Unset = UNSET,
        cancellable: bool | None | _Unset = UNSET,
        *,
        counts: tuple[int | None, int | None] | None = None,
    ) -> None:
        if counts is not None:
            completed = counts[0]
            total = counts[1]
        object.__setattr__(self, "detail", detail)
        object.__setattr__(self, "completed", completed)
        object.__setattr__(self, "total", total)
        object.__setattr__(
            self,
            "phase",
            (
                RuntimeInstallationPhase.of(phase)
                if phase is not UNSET and phase is not None
                else phase
            ),
        )
        object.__setattr__(self, "cancellable", cancellable)

    @classmethod
    def from_install_progress(
        cls, progress: RuntimeInstallProgress
    ) -> RuntimeInstallationProgress:
        return cls(
            detail=progress.detail,
            completed=progress.completed,
            total=progress.total,
            phase=progress.phase,
            cancellable=progress.cancellable,
        )


@dataclass(frozen=True, slots=True)
class RuntimeInstallationJob:
    """Aggregate representing one local runtime installation or download job."""

    id: str
    target: RuntimeInstallationTarget
    status: RuntimeInstallationStatus
    phase: RuntimeInstallationPhase
    cancellable: bool
    detail: str
    completed: int | None
    total: int | None
    created_at: datetime
    updated_at: datetime
    commit_started_at: datetime | None = None
    error: str | None = None

    @property
    def kind(self) -> RuntimeRequirementKind:
        return self.target.kind

    @property
    def provider(self) -> str:
        return self.target.provider

    @property
    def model(self) -> str:
        return self.target.model

    @property
    def is_active(self) -> bool:
        return self.status in ACTIVE_JOB_STATUSES

    @property
    def is_terminal(self) -> bool:
        return self.status in TERMINAL_JOB_STATUSES

    @property
    def is_cancellation_requested(self) -> bool:
        return self.status == RuntimeInstallationStatus.CANCEL_REQUESTED

    @property
    def is_canceled(self) -> bool:
        return self.status == RuntimeInstallationStatus.CANCELED

    @classmethod
    def queue(
        cls,
        *,
        id: str,
        target: RuntimeInstallationTarget,
        detail: str,
        total: int | None,
        now: datetime,
    ) -> RuntimeInstallationJob:
        return cls(
            id=id,
            target=target,
            status=RuntimeInstallationStatus.QUEUED,
            phase=RuntimeInstallationPhase(RuntimeInstallationPhase.QUEUED),
            cancellable=True,
            detail=detail,
            completed=None,
            total=total,
            created_at=now,
            updated_at=now,
            commit_started_at=None,
            error=None,
        )

    @classmethod
    def create_succeeded(
        cls,
        *,
        id: str,
        target: RuntimeInstallationTarget,
        detail: str,
        completed: int | None,
        total: int | None,
        now: datetime,
    ) -> RuntimeInstallationJob:
        return cls(
            id=id,
            target=target,
            status=RuntimeInstallationStatus.SUCCEEDED,
            phase=RuntimeInstallationPhase(RuntimeInstallationPhase.COMPLETED),
            cancellable=False,
            detail=detail,
            completed=completed,
            total=total,
            created_at=now,
            updated_at=now,
            commit_started_at=None,
            error=None,
        )

    def start(self, detail: str, *, now: datetime) -> RuntimeInstallationJob:
        if self.status != RuntimeInstallationStatus.QUEUED:
            return self
        return replace(
            self,
            status=RuntimeInstallationStatus.RUNNING,
            phase=RuntimeInstallationPhase(RuntimeInstallationPhase.STARTING),
            cancellable=True,
            detail=detail,
            updated_at=now,
        )

    def record_progress(
        self, progress: RuntimeInstallationProgress, *, now: datetime
    ) -> RuntimeInstallationJob:
        if self.is_cancellation_requested or self.is_canceled:
            raise RuntimeInstallationCanceledError("Runtime installation was canceled.")

        phase_raw = (
            progress.phase.value
            if isinstance(progress.phase, RuntimeInstallationPhase)
            else progress.phase
        )
        phase_str = (
            phase_raw
            if phase_raw is not None and phase_raw is not UNSET and phase_raw != ""
            else RuntimeInstallationPhase.INSTALLING
        )
        cancellable = (
            progress.cancellable
            if progress.cancellable is not None and progress.cancellable is not UNSET
            else True
        )
        commit_started_at = self.commit_started_at
        if (
            commit_started_at is None
            and phase_str == RuntimeInstallationPhase.COMMITTING
            and not cancellable
        ):
            commit_started_at = now
        if commit_started_at is not None:
            phase_str = RuntimeInstallationPhase.COMMITTING
            cancellable = False

        new_completed = (
            progress.completed if progress.completed is not UNSET else self.completed
        )
        new_total = progress.total if progress.total is not UNSET else self.total
        new_detail = progress.detail if progress.detail is not None else self.detail

        return replace(
            self,
            status=RuntimeInstallationStatus.RUNNING,
            phase=RuntimeInstallationPhase(phase_str),
            cancellable=cancellable,
            detail=new_detail,
            completed=new_completed,
            total=new_total,
            commit_started_at=commit_started_at,
            updated_at=now,
        )

    def cancel(self, *, now: datetime) -> RuntimeInstallationJob:
        if (
            self.status == RuntimeInstallationStatus.SUCCEEDED
            and self.commit_started_at is not None
        ):
            raise OperationNotCancellableError(
                "Runtime installation committed and can no longer be canceled."
            )
        if self.is_terminal or self.is_cancellation_requested:
            return self
        if not self.cancellable:
            raise OperationNotCancellableError(
                "Runtime installation is committing and can no longer be canceled."
            )
        if self.status == RuntimeInstallationStatus.QUEUED:
            return replace(
                self,
                status=RuntimeInstallationStatus.CANCELED,
                phase=RuntimeInstallationPhase(RuntimeInstallationPhase.CANCELED),
                cancellable=False,
                detail="Runtime installation canceled",
                updated_at=now,
            )
        return replace(
            self,
            status=RuntimeInstallationStatus.CANCEL_REQUESTED,
            phase=RuntimeInstallationPhase(RuntimeInstallationPhase.CANCELING),
            cancellable=False,
            detail="Runtime installation cancellation requested",
            updated_at=now,
        )

    def wait_for_user(
        self, *, detail: str, total: int | None, now: datetime
    ) -> RuntimeInstallationJob:
        if self.is_terminal:
            return self
        if self.is_cancellation_requested:
            return replace(
                self,
                status=RuntimeInstallationStatus.CANCELED,
                phase=RuntimeInstallationPhase(RuntimeInstallationPhase.CANCELED),
                cancellable=False,
                detail="Runtime installation canceled",
                error=None,
                updated_at=now,
            )
        return replace(
            self,
            status=RuntimeInstallationStatus.WAITING_FOR_USER,
            phase=RuntimeInstallationPhase(RuntimeInstallationPhase.WAITING_FOR_USER),
            cancellable=True,
            detail=detail,
            completed=None,
            total=total,
            updated_at=now,
        )

    def complete(
        self,
        *,
        detail: str,
        completed: int | None,
        total: int | None,
        now: datetime,
    ) -> RuntimeInstallationJob:
        if self.is_terminal:
            return self
        if self.is_cancellation_requested:
            return replace(
                self,
                status=RuntimeInstallationStatus.CANCELED,
                phase=RuntimeInstallationPhase(RuntimeInstallationPhase.CANCELED),
                cancellable=False,
                detail="Runtime installation canceled",
                error=None,
                updated_at=now,
            )
        return replace(
            self,
            status=RuntimeInstallationStatus.SUCCEEDED,
            phase=RuntimeInstallationPhase(RuntimeInstallationPhase.COMPLETED),
            cancellable=False,
            detail=detail,
            completed=completed,
            total=total,
            error=None,
            updated_at=now,
        )

    def fail(
        self,
        *,
        error: str,
        detail: str | None = None,
        now: datetime,
    ) -> RuntimeInstallationJob:
        if self.is_terminal:
            return self
        if self.is_cancellation_requested:
            return replace(
                self,
                status=RuntimeInstallationStatus.CANCELED,
                phase=RuntimeInstallationPhase(RuntimeInstallationPhase.CANCELED),
                cancellable=False,
                detail="Runtime installation canceled",
                error=None,
                updated_at=now,
            )
        return replace(
            self,
            status=RuntimeInstallationStatus.FAILED,
            phase=RuntimeInstallationPhase(RuntimeInstallationPhase.FAILED),
            cancellable=False,
            detail=detail if detail is not None else error,
            error=error,
            updated_at=now,
        )

    def acknowledge_cancellation(self, *, now: datetime) -> RuntimeInstallationJob:
        if self.is_terminal:
            return self
        return replace(
            self,
            status=RuntimeInstallationStatus.CANCELED,
            phase=RuntimeInstallationPhase(RuntimeInstallationPhase.CANCELED),
            cancellable=False,
            detail="Runtime installation canceled",
            error=None,
            updated_at=now,
        )

    def recover_after_restart(self, *, now: datetime) -> RuntimeInstallationJob:
        if self.status in {
            RuntimeInstallationStatus.QUEUED,
            RuntimeInstallationStatus.RUNNING,
        }:
            return replace(
                self,
                status=RuntimeInstallationStatus.FAILED,
                phase=RuntimeInstallationPhase(RuntimeInstallationPhase.INTERRUPTED),
                cancellable=False,
                detail="Runtime installation was interrupted by an app restart.",
                error="Runtime installation was interrupted by an app restart.",
                updated_at=now,
            )
        if self.is_cancellation_requested:
            return replace(
                self,
                status=RuntimeInstallationStatus.CANCELED,
                phase=RuntimeInstallationPhase(RuntimeInstallationPhase.CANCELED),
                cancellable=False,
                detail="Runtime installation cancellation completed after restart.",
                error=None,
                updated_at=now,
            )
        return self

    def snapshot(self) -> RuntimeInstallationSnapshot:
        return RuntimeInstallationSnapshot(
            id=self.id,
            kind=self.kind,
            provider=self.provider,
            model=self.model,
            status=self.status,
            phase=self.phase.value,
            cancellable=self.cancellable,
            detail=self.detail,
            completed=self.completed,
            total=self.total,
            created_at=self.created_at.isoformat(),
            updated_at=self.updated_at.isoformat(),
            commit_started_at=(
                self.commit_started_at.isoformat()
                if self.commit_started_at is not None
                else None
            ),
            error=self.error,
        )
