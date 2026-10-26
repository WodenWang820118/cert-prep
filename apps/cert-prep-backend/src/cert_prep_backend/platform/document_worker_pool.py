from __future__ import annotations

import logging
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from threading import Condition, Event, RLock, Thread, current_thread
from time import monotonic


logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class DocumentWorkItem:
    operation_id: str
    run: Callable[[], object]
    cancel_queued: Callable[[], None]


@dataclass(frozen=True, slots=True)
class DocumentWorkerPoolSnapshot:
    max_workers: int
    worker_count: int
    alive_worker_count: int
    queued_count: int
    running_count: int
    closed: bool


@dataclass(frozen=True, slots=True)
class DocumentWorkerCloseResult:
    unresolved_operation_ids: tuple[str, ...]

    @property
    def unresolved_count(self) -> int:
        return len(self.unresolved_operation_ids)


class DocumentWorkerPool:
    """App-owned FIFO dispatcher for bounded asynchronous document work."""

    def __init__(self, max_workers: int, *, worker_name_prefix: str) -> None:
        if max_workers < 1:
            raise ValueError("Document worker count must be at least one.")
        if not worker_name_prefix.strip():
            raise ValueError("Document worker name prefix cannot be empty.")
        self._max_workers = max_workers
        self._worker_name_prefix = worker_name_prefix
        self._condition = Condition()
        self._cancel_close_lifecycle = RLock()
        self._queue: deque[DocumentWorkItem] = deque()
        self._queued_by_operation: dict[str, DocumentWorkItem] = {}
        self._running_by_operation: dict[str, DocumentWorkItem] = {}
        self._unresolved_cancellations: dict[str, DocumentWorkItem] = {}
        self._threads: list[Thread] = []
        self._persistent = False
        self._next_thread_index = 1
        self._closed = False
        self._closed_event = Event()

    def start(self) -> None:
        with self._condition:
            self._ensure_started_locked(persistent=True)

    def _ensure_started_locked(self, *, persistent: bool) -> None:
        if self._closed:
            raise RuntimeError("Document worker pool is closed.")
        self._persistent = self._persistent or persistent
        missing_workers = self._max_workers - len(self._threads)
        for _ in range(missing_workers):
            thread = Thread(
                target=self._worker_loop,
                name=f"{self._worker_name_prefix}-{self._next_thread_index}",
                daemon=True,
            )
            self._next_thread_index += 1
            thread.start()
            self._threads.append(thread)

    def submit(self, item: DocumentWorkItem) -> None:
        with self._condition:
            if self._closed:
                raise RuntimeError("Document worker pool is closed.")
            if (
                item.operation_id in self._queued_by_operation
                or item.operation_id in self._running_by_operation
            ):
                raise ValueError(
                    f"Document operation {item.operation_id!r} is already submitted."
                )
            self._queue.append(item)
            self._queued_by_operation[item.operation_id] = item
            try:
                self._ensure_started_locked(persistent=False)
            except Exception:
                self._queued_by_operation.pop(item.operation_id, None)
                self._queue.remove(item)
                self._condition.notify_all()
                raise
            self._condition.notify()

    def cancel(self, operation_id: str) -> bool:
        """Cancel queued work without claiming to interrupt a running item.

        Running document work observes durable cancellation cooperatively. False
        means that the item was not queued, or that its cancellation callback
        failed and the pool retained ownership for retry.
        """
        # Keep the item owned until either its callback succeeds or it is back in
        # the queue. close() uses the same lifecycle lock, so it cannot seal the
        # pool while a failed callback is between those two states.
        with self._cancel_close_lifecycle:
            with self._condition:
                item = self._queued_by_operation.pop(operation_id, None)
                if item is None:
                    return False
                self._queue.remove(item)
                self._condition.notify_all()
            if self._invoke_cancel_callback(item):
                return True
            with self._condition:
                if self._closed:
                    self._unresolved_cancellations[item.operation_id] = item
                    return False
                self._queue.appendleft(item)
                self._queued_by_operation[item.operation_id] = item
                try:
                    self._ensure_started_locked(persistent=False)
                except Exception:
                    logger.exception(
                        "Document worker could not restart after cancellation callback failure",
                        extra={"operation_id": item.operation_id},
                    )
                self._condition.notify()
        return False

    def close(self, *, join_timeout_seconds: float) -> DocumentWorkerCloseResult:
        if join_timeout_seconds < 0:
            raise ValueError("Document worker join timeout cannot be negative.")
        with self._cancel_close_lifecycle:
            with self._condition:
                retry = list(self._unresolved_cancellations.values())
                self._unresolved_cancellations.clear()
                if self._closed:
                    pending: list[DocumentWorkItem] = []
                    running: list[DocumentWorkItem] = []
                else:
                    self._closed = True
                    self._closed_event.set()
                    pending = list(self._queue)
                    running = list(self._running_by_operation.values())
                    self._queue.clear()
                    self._queued_by_operation.clear()
                    self._condition.notify_all()
                threads = tuple(self._threads)

            cancellation_items = {
                item.operation_id: item for item in (*retry, *pending, *running)
            }
            for item in cancellation_items.values():
                if not self._invoke_cancel_callback(item):
                    self._unresolved_cancellations[item.operation_id] = item
            close_result = DocumentWorkerCloseResult(
                unresolved_operation_ids=tuple(self._unresolved_cancellations)
            )

        deadline = monotonic() + join_timeout_seconds
        for thread in threads:
            thread.join(timeout=max(0.0, deadline - monotonic()))
        return close_result

    def is_closed(self) -> bool:
        return self._closed_event.is_set()

    def snapshot(self) -> DocumentWorkerPoolSnapshot:
        with self._condition:
            return DocumentWorkerPoolSnapshot(
                max_workers=self._max_workers,
                worker_count=len(self._threads),
                alive_worker_count=sum(thread.is_alive() for thread in self._threads),
                queued_count=len(self._queue),
                running_count=len(self._running_by_operation),
                closed=self._closed,
            )

    def _worker_loop(self) -> None:
        while True:
            with self._condition:
                while not self._queue and not self._closed:
                    if not self._persistent:
                        self._threads.remove(current_thread())
                        self._condition.notify_all()
                        return
                    self._condition.wait()
                if self._closed and not self._queue:
                    self._threads.remove(current_thread())
                    self._condition.notify_all()
                    return
                item = self._queue.popleft()
                self._queued_by_operation.pop(item.operation_id, None)
                self._running_by_operation[item.operation_id] = item
            try:
                item.run()
            except Exception:
                logger.exception(
                    "Document worker failed",
                    extra={"operation_id": item.operation_id},
                )
            finally:
                with self._condition:
                    self._running_by_operation.pop(item.operation_id, None)
                    self._condition.notify_all()

    @staticmethod
    def _invoke_cancel_callback(item: DocumentWorkItem) -> bool:
        try:
            item.cancel_queued()
        except Exception:
            logger.exception(
                "Queued document cancellation callback failed",
                extra={"operation_id": item.operation_id},
            )
            return False
        return True


__all__ = [
    "DocumentWorkerCloseResult",
    "DocumentWorkerPool",
    "DocumentWorkerPoolSnapshot",
    "DocumentWorkItem",
]
