"""The source worker pool as the Source Library's source work."""

from __future__ import annotations

from collections.abc import Callable

from cert_prep_backend.platform.source_worker_pool import SourceWorkItem, SourceWorkerPool


class PoolSourceWork:
    """Runs source processing on the process's source worker pool."""

    def __init__(self, pool: SourceWorkerPool) -> None:
        self._pool = pool

    def submit(
        self,
        *,
        operation_id: str,
        run: Callable[[], object],
        cancel_queued: Callable[[], None],
    ) -> None:
        self._pool.submit(
            SourceWorkItem(operation_id=operation_id, run=run, cancel_queued=cancel_queued)
        )

    def cancel(self, operation_id: str) -> bool:
        return self._pool.cancel(operation_id)

    def is_closed(self) -> bool:
        return self._pool.is_closed()
