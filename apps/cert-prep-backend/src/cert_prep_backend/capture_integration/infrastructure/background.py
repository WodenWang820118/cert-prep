"""Document worker pool as capture review's background work."""

from __future__ import annotations

from collections.abc import Callable

from cert_prep_backend.platform.document_worker_pool import DocumentWorkItem, DocumentWorkerPool


class PoolCaptureBackgroundWork:
    """Submits capture review work to the process document worker pool."""

    def __init__(self, pool: DocumentWorkerPool) -> None:
        self._pool = pool

    def submit(
        self,
        *,
        operation_id: str,
        run: Callable[[], None],
        cancel_queued: Callable[[], None],
    ) -> None:
        self._pool.submit(
            DocumentWorkItem(operation_id=operation_id, run=run, cancel_queued=cancel_queued)
        )

    def is_closed(self) -> bool:
        return self._pool.is_closed()
