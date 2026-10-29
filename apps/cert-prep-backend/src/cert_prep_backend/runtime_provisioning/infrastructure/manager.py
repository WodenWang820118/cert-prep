"""Technical ownership of runtime installation workers and cancellation signals."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from contextlib import AbstractContextManager
from datetime import UTC, datetime
from threading import Event, Thread
from uuid import uuid4

from cert_prep_backend.runtime_provisioning.application.ports import RuntimeInstallationWorker


def utcnow() -> datetime:
    return datetime.now(UTC)


class ThreadRuntimeInstallationWork:
    """Owns installation threads and cancellation Events; application decides what to run."""

    def __init__(self, lock: AbstractContextManager, *, async_jobs: bool = True) -> None:
        self._lock = lock
        self._async_jobs = async_jobs
        self._cancellation_signals: dict[str, Event] = {}
        self._job_threads: list[Thread] = []

    @staticmethod
    def clock() -> datetime:
        return utcnow()

    @staticmethod
    def new_id() -> str:
        return str(uuid4())

    def prepare(self, job_id: str) -> None:
        with self._lock:
            self._cancellation_signals[job_id] = Event()

    def forget(self, job_id: str) -> None:
        with self._lock:
            self._cancellation_signals.pop(job_id, None)

    def signal_cancellation(self, job_id: str) -> None:
        with self._lock:
            signal = self._cancellation_signals.get(job_id)
            if signal is not None:
                signal.set()

    def cancellation_requested(self, job_id: str) -> bool:
        with self._lock:
            signal = self._cancellation_signals.get(job_id)
            return signal is not None and signal.is_set()

    def schedule(self, job_id: str, action: Callable[[], None]) -> None:
        if not self._async_jobs:
            action()
            return
        worker = Thread(
            target=action, args=(), name=f"runtime-installation-{job_id[:8]}", daemon=True,
        )
        with self._lock:
            self._job_threads = [thread for thread in self._job_threads if thread.is_alive()]
            self._job_threads.append(worker)
        worker.start()

    def workers(self) -> list[RuntimeInstallationWorker]:
        with self._lock:
            return list(self._job_threads)

    def join_workers(self, workers: Sequence[RuntimeInstallationWorker]) -> None:
        for worker in workers:
            worker.join(timeout=1)
