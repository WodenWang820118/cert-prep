"""The document worker pool as the Source Library's document work."""

from __future__ import annotations

from collections.abc import Callable

from cert_prep_backend.platform.document_worker_pool import DocumentWorkItem, DocumentWorkerPool


class PoolDocumentWork:
    """Runs document processing on the process's document worker pool."""

    def __init__(self, pool: DocumentWorkerPool) -> None:
        self._pool = pool

    def submit(
        self,
        *,
        operation_id: str,
        run: Callable[[], object],
        cancel_queued: Callable[[], None],
    ) -> None:
        self._pool.submit(
            DocumentWorkItem(operation_id=operation_id, run=run, cancel_queued=cancel_queued)
        )

    def cancel(self, operation_id: str) -> bool:
        return self._pool.cancel(operation_id)

    def is_closed(self) -> bool:
        return self._pool.is_closed()
