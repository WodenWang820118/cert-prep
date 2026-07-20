from __future__ import annotations

from collections import deque
from collections.abc import Callable, Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from threading import Condition

from cert_prep_backend.core.exceptions import DocumentProcessingCanceledError


_CANCEL_CHECK_INTERVAL_SECONDS = 0.05


@dataclass(frozen=True, slots=True)
class AudioTranscriptionGateSnapshot:
    max_parallel_transcriptions: int
    active_count: int
    waiting_count: int
    closed: bool


class AudioTranscriptionGate:
    """FIFO, cancellation-aware limit for concurrent audio transcriptions."""

    def __init__(self, max_parallel_transcriptions: int) -> None:
        if max_parallel_transcriptions < 1:
            raise ValueError("Audio transcription parallelism must be at least one.")
        self._max_parallel_transcriptions = max_parallel_transcriptions
        self._condition = Condition()
        self._waiters: deque[object] = deque()
        self._active_count = 0
        self._closed = False

    @contextmanager
    def acquire(
        self,
        *,
        should_cancel: Callable[[], bool] | None = None,
    ) -> Iterator[None]:
        waiter = object()
        acquired = False
        with self._condition:
            self._raise_if_closed_locked()
            self._waiters.append(waiter)
            self._condition.notify_all()

        try:
            while not acquired:
                self._raise_if_closed()
                self._raise_if_canceled(should_cancel)
                with self._condition:
                    self._raise_if_closed_locked()
                    if (
                        self._waiters
                        and self._waiters[0] is waiter
                        and self._active_count < self._max_parallel_transcriptions
                    ):
                        self._waiters.popleft()
                        self._active_count += 1
                        acquired = True
                    else:
                        self._condition.wait(_CANCEL_CHECK_INTERVAL_SECONDS)
            self._raise_if_closed()
            self._raise_if_canceled(should_cancel)
            yield
        finally:
            with self._condition:
                if acquired:
                    self._active_count -= 1
                else:
                    with suppress(ValueError):
                        self._waiters.remove(waiter)
                self._condition.notify_all()

    def close(self) -> None:
        """Reject new leases and wake all queued transcription workers."""

        with self._condition:
            self._closed = True
            self._condition.notify_all()

    def is_closed(self) -> bool:
        with self._condition:
            return self._closed

    def snapshot(self) -> AudioTranscriptionGateSnapshot:
        with self._condition:
            return AudioTranscriptionGateSnapshot(
                max_parallel_transcriptions=self._max_parallel_transcriptions,
                active_count=self._active_count,
                waiting_count=len(self._waiters),
                closed=self._closed,
            )

    def _raise_if_closed(self) -> None:
        with self._condition:
            self._raise_if_closed_locked()

    def _raise_if_closed_locked(self) -> None:
        if self._closed:
            raise DocumentProcessingCanceledError(
                "Audio transcription was canceled because the backend is shutting down."
            )

    @staticmethod
    def _raise_if_canceled(should_cancel: Callable[[], bool] | None) -> None:
        if should_cancel is not None and should_cancel():
            raise DocumentProcessingCanceledError(
                "Audio transcription was canceled while waiting for a worker."
            )


__all__ = ["AudioTranscriptionGate", "AudioTranscriptionGateSnapshot"]
