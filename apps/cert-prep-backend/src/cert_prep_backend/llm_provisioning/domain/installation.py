"""The LLMInstallationJob aggregate and value objects."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from typing import ClassVar

from cert_prep_contracts.llm_installation import (
    LLMInstallationStatus,
    LLMInstallProgress,
    LLMRequirementKind,
)
from cert_prep_backend.platform.errors import OperationNotCancellableError
from cert_prep_backend.llm_provisioning.domain.models import LLMInstallationSnapshot

__all__ = [
    "ACTIVE_JOB_STATUSES",
    "TERMINAL_JOB_STATUSES",
    "LLMInstallationCanceledError",
    "LLMInstallationJob",
    "LLMInstallationPhase",
    "LLMInstallationProgress",
    "LLMInstallationTarget",
    "UNSET",
]


class _Unset:
    def __repr__(self) -> str:
        return "UNSET"

    def __bool__(self) -> bool:
        return False


UNSET = _Unset()


class LLMInstallationCanceledError(RuntimeError):
    """Raised when an installation job transition is rejected due to cancellation."""


ACTIVE_JOB_STATUSES: frozenset[LLMInstallationStatus] = frozenset(
    {
        LLMInstallationStatus.QUEUED,
        LLMInstallationStatus.RUNNING,
        LLMInstallationStatus.CANCEL_REQUESTED,
        LLMInstallationStatus.WAITING_FOR_USER,
    }
)

TERMINAL_JOB_STATUSES: frozenset[LLMInstallationStatus] = frozenset(
    {
        LLMInstallationStatus.SUCCEEDED,
        LLMInstallationStatus.FAILED,
        LLMInstallationStatus.CANCELED,
    }
)


@dataclass(frozen=True, slots=True)
class LLMInstallationTarget:
    """The requirement kind, provider, and model being installed."""

    kind: LLMRequirementKind
    provider: str
    model: str

    def __post_init__(self) -> None:
        if not isinstance(self.kind, LLMRequirementKind):
            object.__setattr__(self, "kind", LLMRequirementKind(self.kind))
        if not isinstance(self.provider, str):
            object.__setattr__(self, "provider", str(self.provider))
        if not isinstance(self.model, str):
            object.__setattr__(self, "model", str(self.model))


@dataclass(frozen=True, slots=True)
class LLMInstallationPhase:
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
        if isinstance(other, LLMInstallationPhase):
            return self.value == other.value
        if isinstance(other, str):
            return self.value == other
        return False

    def __hash__(self) -> int:
        return hash(self.value)

    @classmethod
    def of(cls, value: LLMInstallationPhase | str) -> LLMInstallationPhase:
        if isinstance(value, LLMInstallationPhase):
            return value
        return cls(str(value))


@dataclass(frozen=True, slots=True)
class LLMInstallationProgress:
    """Progress update for an installation job; distinguishes omitted updates from explicit null."""

    detail: str | None = None
    completed: int | None | _Unset = UNSET
    total: int | None | _Unset = UNSET
    phase: LLMInstallationPhase | str | None | _Unset = UNSET
    cancellable: bool | None | _Unset = UNSET

    def __init__(
        self,
        detail: str | None = None,
        completed: int | None | _Unset = UNSET,
        total: int | None | _Unset = UNSET,
        phase: LLMInstallationPhase | str | None | _Unset = UNSET,
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
                LLMInstallationPhase.of(phase)
                if phase is not UNSET and phase is not None
                else phase
            ),
        )
        object.__setattr__(self, "cancellable", cancellable)

    @classmethod
    def from_install_progress(
        cls, progress: LLMInstallProgress
    ) -> LLMInstallationProgress:
        return cls(
            detail=progress.detail,
            completed=progress.completed,
            total=progress.total,
            phase=progress.phase,
            cancellable=progress.cancellable,
        )


@dataclass(frozen=True, slots=True)
class LLMInstallationJob:
    """Aggregate representing one local LLM installation or download job."""

    id: str
    target: LLMInstallationTarget
    status: LLMInstallationStatus
    phase: LLMInstallationPhase
    cancellable: bool
    detail: str
    completed: int | None
    total: int | None
    created_at: datetime
    updated_at: datetime
    commit_started_at: datetime | None = None
    error: str | None = None

    @property
    def kind(self) -> LLMRequirementKind:
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
        return self.status == LLMInstallationStatus.CANCEL_REQUESTED

    @property
    def is_canceled(self) -> bool:
        return self.status == LLMInstallationStatus.CANCELED

    @classmethod
    def queue(
        cls,
        *,
        id: str,
        target: LLMInstallationTarget,
        detail: str,
        total: int | None,
        now: datetime,
    ) -> LLMInstallationJob:
        return cls(
            id=id,
            target=target,
            status=LLMInstallationStatus.QUEUED,
            phase=LLMInstallationPhase(LLMInstallationPhase.QUEUED),
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
        target: LLMInstallationTarget,
        detail: str,
        completed: int | None,
        total: int | None,
        now: datetime,
    ) -> LLMInstallationJob:
        return cls(
            id=id,
            target=target,
            status=LLMInstallationStatus.SUCCEEDED,
            phase=LLMInstallationPhase(LLMInstallationPhase.COMPLETED),
            cancellable=False,
            detail=detail,
            completed=completed,
            total=total,
            created_at=now,
            updated_at=now,
            commit_started_at=None,
            error=None,
        )

    def start(self, detail: str, *, now: datetime) -> LLMInstallationJob:
        if self.status != LLMInstallationStatus.QUEUED:
            return self
        return replace(
            self,
            status=LLMInstallationStatus.RUNNING,
            phase=LLMInstallationPhase(LLMInstallationPhase.STARTING),
            cancellable=True,
            detail=detail,
            updated_at=now,
        )

    def record_progress(
        self, progress: LLMInstallationProgress, *, now: datetime
    ) -> LLMInstallationJob:
        if self.is_cancellation_requested or self.is_canceled:
            raise LLMInstallationCanceledError("LLM installation was canceled.")

        phase_raw = (
            progress.phase.value
            if isinstance(progress.phase, LLMInstallationPhase)
            else progress.phase
        )
        phase_str = (
            phase_raw
            if phase_raw is not None and phase_raw is not UNSET and phase_raw != ""
            else LLMInstallationPhase.INSTALLING
        )
        cancellable = (
            progress.cancellable
            if progress.cancellable is not None and progress.cancellable is not UNSET
            else True
        )
        commit_started_at = self.commit_started_at
        if (
            commit_started_at is None
            and phase_str == LLMInstallationPhase.COMMITTING
            and not cancellable
        ):
            commit_started_at = now
        if commit_started_at is not None:
            phase_str = LLMInstallationPhase.COMMITTING
            cancellable = False

        new_completed = (
            progress.completed if progress.completed is not UNSET else self.completed
        )
        new_total = progress.total if progress.total is not UNSET else self.total
        new_detail = progress.detail if progress.detail is not None else self.detail

        return replace(
            self,
            status=LLMInstallationStatus.RUNNING,
            phase=LLMInstallationPhase(phase_str),
            cancellable=cancellable,
            detail=new_detail,
            completed=new_completed,
            total=new_total,
            commit_started_at=commit_started_at,
            updated_at=now,
        )

    def cancel(self, *, now: datetime) -> LLMInstallationJob:
        if (
            self.status == LLMInstallationStatus.SUCCEEDED
            and self.commit_started_at is not None
        ):
            raise OperationNotCancellableError(
                "LLM installation committed and can no longer be canceled."
            )
        if self.is_terminal or self.is_cancellation_requested:
            return self
        if not self.cancellable:
            raise OperationNotCancellableError(
                "LLM installation is committing and can no longer be canceled."
            )
        if self.status == LLMInstallationStatus.QUEUED:
            return replace(
                self,
                status=LLMInstallationStatus.CANCELED,
                phase=LLMInstallationPhase(LLMInstallationPhase.CANCELED),
                cancellable=False,
                detail="LLM installation canceled",
                updated_at=now,
            )
        return replace(
            self,
            status=LLMInstallationStatus.CANCEL_REQUESTED,
            phase=LLMInstallationPhase(LLMInstallationPhase.CANCELING),
            cancellable=False,
            detail="LLM installation cancellation requested",
            updated_at=now,
        )

    def wait_for_user(
        self, *, detail: str, total: int | None, now: datetime
    ) -> LLMInstallationJob:
        if self.is_terminal:
            return self
        if self.is_cancellation_requested:
            return replace(
                self,
                status=LLMInstallationStatus.CANCELED,
                phase=LLMInstallationPhase(LLMInstallationPhase.CANCELED),
                cancellable=False,
                detail="LLM installation canceled",
                error=None,
                updated_at=now,
            )
        return replace(
            self,
            status=LLMInstallationStatus.WAITING_FOR_USER,
            phase=LLMInstallationPhase(LLMInstallationPhase.WAITING_FOR_USER),
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
    ) -> LLMInstallationJob:
        if self.is_terminal:
            return self
        if self.is_cancellation_requested:
            return replace(
                self,
                status=LLMInstallationStatus.CANCELED,
                phase=LLMInstallationPhase(LLMInstallationPhase.CANCELED),
                cancellable=False,
                detail="LLM installation canceled",
                error=None,
                updated_at=now,
            )
        return replace(
            self,
            status=LLMInstallationStatus.SUCCEEDED,
            phase=LLMInstallationPhase(LLMInstallationPhase.COMPLETED),
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
    ) -> LLMInstallationJob:
        if self.is_terminal:
            return self
        if self.is_cancellation_requested:
            return replace(
                self,
                status=LLMInstallationStatus.CANCELED,
                phase=LLMInstallationPhase(LLMInstallationPhase.CANCELED),
                cancellable=False,
                detail="LLM installation canceled",
                error=None,
                updated_at=now,
            )
        return replace(
            self,
            status=LLMInstallationStatus.FAILED,
            phase=LLMInstallationPhase(LLMInstallationPhase.FAILED),
            cancellable=False,
            detail=detail if detail is not None else error,
            error=error,
            updated_at=now,
        )

    def acknowledge_cancellation(self, *, now: datetime) -> LLMInstallationJob:
        if self.is_terminal:
            return self
        return replace(
            self,
            status=LLMInstallationStatus.CANCELED,
            phase=LLMInstallationPhase(LLMInstallationPhase.CANCELED),
            cancellable=False,
            detail="LLM installation canceled",
            error=None,
            updated_at=now,
        )

    def recover_after_restart(self, *, now: datetime) -> LLMInstallationJob:
        if self.status in {
            LLMInstallationStatus.QUEUED,
            LLMInstallationStatus.RUNNING,
        }:
            return replace(
                self,
                status=LLMInstallationStatus.FAILED,
                phase=LLMInstallationPhase(LLMInstallationPhase.INTERRUPTED),
                cancellable=False,
                detail="LLM installation was interrupted by an app restart.",
                error="LLM installation was interrupted by an app restart.",
                updated_at=now,
            )
        if self.is_cancellation_requested:
            return replace(
                self,
                status=LLMInstallationStatus.CANCELED,
                phase=LLMInstallationPhase(LLMInstallationPhase.CANCELED),
                cancellable=False,
                detail="LLM installation cancellation completed after restart.",
                error=None,
                updated_at=now,
            )
        return self

    def snapshot(self) -> LLMInstallationSnapshot:
        return LLMInstallationSnapshot(
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
