from __future__ import annotations

from threading import Condition


class DatabaseChangeNotifier:
    """Process-local wake-up source for durable SQLite transaction changes."""

    _MAX_REVISION = (1 << 63) - 1

    def __init__(self) -> None:
        self._condition = Condition()
        self._revision = 0

    def publish(self) -> int:
        with self._condition:
            self._revision = (
                0 if self._revision >= self._MAX_REVISION else self._revision + 1
            )
            self._condition.notify_all()
            return self._revision

    def revision(self) -> int:
        with self._condition:
            return self._revision

    def wait_for_change(
        self,
        observed_revision: int,
        *,
        timeout_seconds: float,
    ) -> int:
        with self._condition:
            self._condition.wait_for(
                lambda: self._revision != observed_revision,
                timeout=timeout_seconds,
            )
            return self._revision


__all__ = ["DatabaseChangeNotifier"]
