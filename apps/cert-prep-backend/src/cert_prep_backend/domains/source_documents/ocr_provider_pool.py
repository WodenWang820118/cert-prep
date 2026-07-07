from __future__ import annotations

from collections.abc import Callable
from contextlib import suppress
from queue import Queue
from threading import Lock
from types import TracebackType

from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.source_documents.ocr import OCRProvider, ocr_provider_from_settings


OCRProviderFactory = Callable[[], OCRProvider]


class DocumentOCRProviderLease:
    def __init__(
        self,
        pool: DocumentOCRProviderPool,
        slot_index: int,
        provider: OCRProvider,
    ) -> None:
        self._pool = pool
        self._slot_index = slot_index
        self._provider = provider

    def __enter__(self) -> OCRProvider:
        return self._provider

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self._pool.release(self._slot_index)


class DocumentOCRProviderPool:
    def __init__(
        self,
        *,
        max_parallel_documents: int,
        provider_factory: OCRProviderFactory,
        prepare_on_acquire: bool,
        close_providers_on_shutdown: bool,
    ) -> None:
        self._max_parallel_documents = max(1, max_parallel_documents)
        self._provider_factory = provider_factory
        self._prepare_on_acquire = prepare_on_acquire
        self._close_providers_on_shutdown = close_providers_on_shutdown
        self._available_slots: Queue[int] = Queue()
        for slot_index in range(self._max_parallel_documents):
            self._available_slots.put(slot_index)
        self._providers: list[OCRProvider | None] = [
            None for _ in range(self._max_parallel_documents)
        ]
        self._prepared_slots: set[int] = set()
        self._has_prepared_provider = False
        self._lock = Lock()
        self._prepare_lock = Lock()
        self._closed = False

    def prepare(self) -> None:
        with self._prepare_lock:
            with self._lock:
                if self._closed:
                    raise RuntimeError("Document OCR provider pool is closed.")
                if self._has_prepared_provider:
                    return
            with self.acquire():
                pass
            with self._lock:
                if not self._closed:
                    self._has_prepared_provider = True

    def acquire(self) -> DocumentOCRProviderLease:
        slot_index = self._available_slots.get()
        with self._lock:
            if self._closed:
                self._available_slots.put(slot_index)
                raise RuntimeError("Document OCR provider pool is closed.")
        try:
            provider = self._provider_for_slot(slot_index)
            return DocumentOCRProviderLease(self, slot_index, provider)
        except Exception:
            self._available_slots.put(slot_index)
            raise

    def release(self, slot_index: int) -> None:
        self._available_slots.put(slot_index)

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True

        drained_slots = [
            self._available_slots.get()
            for _ in range(self._max_parallel_documents)
        ]

        if not self._close_providers_on_shutdown:
            for slot_index in drained_slots:
                self._available_slots.put(slot_index)
            return
        with self._lock:
            for slot_index, provider in enumerate(self._providers):
                if provider is None:
                    continue
                self._close_provider_safely(provider)
                self._providers[slot_index] = None
            self._prepared_slots.clear()
            self._has_prepared_provider = False

        for slot_index in drained_slots:
            self._available_slots.put(slot_index)

    def _provider_for_slot(self, slot_index: int) -> OCRProvider:
        provider = self._providers[slot_index]
        if provider is not None:
            self._prepare_provider_once(slot_index, provider)
            return provider

        provider = self._provider_factory()
        try:
            self._prepare_provider_once(slot_index, provider)
        except Exception:
            self._close_provider_safely(provider)
            raise
        self._providers[slot_index] = provider
        return provider

    def _prepare_provider_once(self, slot_index: int, provider: OCRProvider) -> None:
        if not self._prepare_on_acquire or slot_index in self._prepared_slots:
            return
        _prepare_document_ocr_provider(provider)
        self._prepared_slots.add(slot_index)

    def _close_provider_safely(self, provider: OCRProvider) -> None:
        close = getattr(provider, "close", None)
        if callable(close):
            with suppress(Exception):
                close()


def provider_pool_from_settings(settings: Settings) -> DocumentOCRProviderPool:
    return DocumentOCRProviderPool(
        max_parallel_documents=settings.document_ocr_parallelism,
        provider_factory=lambda: ocr_provider_from_settings(settings),
        prepare_on_acquire=True,
        close_providers_on_shutdown=True,
    )


def shared_provider_pool(provider: OCRProvider) -> DocumentOCRProviderPool:
    return DocumentOCRProviderPool(
        max_parallel_documents=1,
        provider_factory=lambda: provider,
        prepare_on_acquire=True,
        close_providers_on_shutdown=False,
    )


def factory_provider_pool(
    settings: Settings,
    provider_factory: OCRProviderFactory,
) -> DocumentOCRProviderPool:
    return DocumentOCRProviderPool(
        max_parallel_documents=settings.document_ocr_parallelism,
        provider_factory=provider_factory,
        prepare_on_acquire=True,
        close_providers_on_shutdown=True,
    )


def _prepare_document_ocr_provider(ocr_provider: OCRProvider) -> None:
    prepare = getattr(ocr_provider, "prepare_for_document_ocr", None)
    if callable(prepare):
        prepare()
