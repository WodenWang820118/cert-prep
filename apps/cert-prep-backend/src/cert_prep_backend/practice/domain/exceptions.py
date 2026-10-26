from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from cert_prep_backend.practice.domain.session import PracticeSession


class PracticeRuleViolation(ValueError):
    """An answer or a new session breaks a practice rule."""


class PracticeSessionConflict(RuntimeError):
    """The session's state does not allow the request, e.g. it was abandoned."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        active_session: PracticeSession | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.active_session = active_session
