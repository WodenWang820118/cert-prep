import logging
import platform
import sqlite3
import sys
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

from cert_prep_backend import __version__
from cert_prep_backend.api.dependencies import require_bearer_auth
from cert_prep_backend.core.config import Settings
from cert_prep_backend.persistence.database import Database
from cert_prep_backend.domains.mock_exams.ports import DraftGenerationProvider as LLMProvider
from cert_prep_backend.domains.mock_exams.provider import lazy_provider_from_settings
from cert_prep_backend.domains.mock_exams.streaming import StreamingDraftGenerationManager
from cert_prep_backend.domains.runtime_installations import RuntimeInstallationManager
from cert_prep_backend.domains.source_documents import repository as source_documents_repository
from cert_prep_backend.domains.source_documents.audio_transcription_gate import (
    AudioTranscriptionGate,
)
from cert_prep_backend.domains.source_documents.document_worker_pool import (
    DocumentWorkerPool,
)
from cert_prep_backend.domains.source_documents.operations import recover_operations
from cert_prep_backend.domains.source_documents.ocr import OCRProvider, ocr_provider_from_settings
from cert_prep_backend.domains.source_documents.ocr_provider_pool import (
    DocumentOCRProviderPool,
    OCRProviderFactory,
    factory_provider_pool,
    provider_pool_from_settings,
    shared_provider_pool,
)
from cert_prep_backend.routers import documents, drafts, llm, ocr, practice, projects, runtime
from cert_prep_contracts.transcription import TranscriptionProvider
from cert_prep_transcription_whisper import WhisperTranscriptionProvider


class HealthResponse(BaseModel):
    status: str
    app: str
    version: str
    python_version: str
    runtime_mode: str


DOCUMENT_WORKER_JOIN_TIMEOUT_SECONDS = 2.0
logger = logging.getLogger(__name__)


def create_app(
    settings: Settings | None = None,
    llm_provider: LLMProvider | None = None,
    ocr_provider: OCRProvider | None = None,
    document_ocr_provider_factory: OCRProviderFactory | None = None,
    runtime_installation_manager: RuntimeInstallationManager | None = None,
    runtime_installation_async_jobs: bool = True,
    document_processing_async_jobs: bool = True,
    streaming_draft_generation_async_jobs: bool = True,
    transcription_provider: TranscriptionProvider | None = None,
) -> FastAPI:
    app_settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        try:
            app.state.audio_document_worker_pool.start()
            app.state.document_ocr_worker_pool.start()
            yield
        finally:
            app.state.audio_transcription_gate.close()
            app.state.audio_document_worker_pool.close(join_timeout_seconds=0)
            app.state.document_ocr_worker_pool.close(join_timeout_seconds=0)
            audio_close_result = app.state.audio_document_worker_pool.close(
                join_timeout_seconds=DOCUMENT_WORKER_JOIN_TIMEOUT_SECONDS
            )
            ocr_close_result = app.state.document_ocr_worker_pool.close(
                join_timeout_seconds=DOCUMENT_WORKER_JOIN_TIMEOUT_SECONDS
            )
            for worker_kind, close_result in (
                ("audio", audio_close_result),
                ("ocr", ocr_close_result),
            ):
                if close_result.unresolved_operation_ids:
                    logger.error(
                        "Document worker shutdown retained unresolved cancellations: "
                        "worker_kind=%s operation_ids=%s",
                        worker_kind,
                        ",".join(close_result.unresolved_operation_ids),
                        extra={
                            "worker_kind": worker_kind,
                            "operation_ids": close_result.unresolved_operation_ids,
                        },
                    )
            ocr_workers_stopped = (
                app.state.document_ocr_worker_pool.snapshot().alive_worker_count == 0
            )
            app.state.runtime_installation_manager.close()
            app.state.streaming_draft_generation_manager.close()
            if ocr_workers_stopped:
                app.state.document_ocr_provider_pool.close()
            else:
                logger.warning(
                    "OCR document workers exceeded the shutdown join timeout; "
                    "provider shutdown is deferred to avoid closing an active lease."
                )
            llm_provider_close = getattr(app.state.llm_provider, "close", None)
            if callable(llm_provider_close):
                llm_provider_close()
            ocr_provider_close = getattr(app.state.ocr_provider, "close", None)
            if ocr_workers_stopped and callable(ocr_provider_close):
                ocr_provider_close()

    app = FastAPI(
        title="Cert Prep Backend",
        version=__version__,
        summary="Local sidecar API for the cert prep desktop app.",
        lifespan=lifespan,
    )
    app.state.settings = app_settings
    app.state.database = Database(app_settings)
    recover_operations(app.state.database)
    source_documents_repository.recover_processing_documents(app.state.database)
    app.state.llm_provider = llm_provider or lazy_provider_from_settings(app_settings)
    app.state.ocr_provider = ocr_provider or ocr_provider_from_settings(app_settings)
    app.state.transcription_provider = (
        transcription_provider or WhisperTranscriptionProvider(prefer_gpu=True)
    )
    app.state.audio_transcription_gate = AudioTranscriptionGate(
        app_settings.audio_transcription_parallelism
    )
    app.state.audio_document_worker_pool = DocumentWorkerPool(
        app_settings.audio_transcription_parallelism,
        worker_name_prefix="audio-document-worker",
    )
    app.state.document_ocr_worker_pool = DocumentWorkerPool(
        app_settings.document_ocr_parallelism,
        worker_name_prefix="ocr-document-worker",
    )
    app.state.document_ocr_provider_pool = _document_ocr_provider_pool(
        settings=app_settings,
        ocr_provider=ocr_provider,
        provider_factory=document_ocr_provider_factory,
    )
    app.state.document_processing_async_jobs = document_processing_async_jobs
    app.state.runtime_installation_async_jobs = runtime_installation_async_jobs
    app.state.streaming_draft_generation_manager = StreamingDraftGenerationManager(
        settings=app_settings,
        provider=app.state.llm_provider,
        async_jobs=streaming_draft_generation_async_jobs,
    )
    app.state.streaming_draft_generation_manager.recover_jobs(app.state.database)
    app.state.runtime_installation_manager = runtime_installation_manager or RuntimeInstallationManager(
        settings=app_settings,
        llm_provider=app.state.llm_provider,
        ocr_provider=app.state.ocr_provider,
        transcription_provider=app.state.transcription_provider,
        db=app.state.database,
        async_jobs=runtime_installation_async_jobs,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=app_settings.allowed_origins,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "X-Cert-Prep-Operation-Id",
        ],
    )

    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(
        _request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=_error_content(exc.status_code, exc.detail),
            headers=exc.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={
                "code": "validation_error",
                "message": "Request validation failed.",
                "details": {"errors": exc.errors()},
            },
        )

    @app.exception_handler(sqlite3.IntegrityError)
    async def integrity_error_handler(
        _request: Request, _exc: sqlite3.IntegrityError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={
                "code": "validation_error",
                "message": "Request violates a data relationship.",
            },
        )

    @app.get("/health", response_model=HealthResponse, tags=["system"])
    async def health() -> HealthResponse:
        return HealthResponse(
            status="ok",
            app="cert-prep-backend",
            version=__version__,
            python_version=platform.python_version(),
            runtime_mode="packaged" if getattr(sys, "frozen", False) else "source",
        )

    protected_dependencies = [Depends(require_bearer_auth)]
    app.include_router(projects.router, dependencies=protected_dependencies)
    app.include_router(documents.router, dependencies=protected_dependencies)
    app.include_router(documents.operations_router, dependencies=protected_dependencies)
    app.include_router(drafts.documents_router, dependencies=protected_dependencies)
    app.include_router(drafts.draft_jobs_router, dependencies=protected_dependencies)
    app.include_router(drafts.manual_operations_router, dependencies=protected_dependencies)
    app.include_router(drafts.drafts_router, dependencies=protected_dependencies)
    app.include_router(practice.router, dependencies=protected_dependencies)
    app.include_router(llm.router, dependencies=protected_dependencies)
    app.include_router(ocr.router, dependencies=protected_dependencies)
    app.include_router(runtime.router, dependencies=protected_dependencies)

    return app


def _document_ocr_provider_pool(
    *,
    settings: Settings,
    ocr_provider: OCRProvider | None,
    provider_factory: Callable[[], OCRProvider] | None,
) -> DocumentOCRProviderPool:
    if provider_factory is not None:
        return factory_provider_pool(settings, provider_factory)
    if ocr_provider is not None:
        return shared_provider_pool(ocr_provider)
    return provider_pool_from_settings(settings)


def _error_content(status_code: int, detail: Any) -> dict[str, Any]:
    if isinstance(detail, dict) and "code" in detail and "message" in detail:
        return detail
    if isinstance(detail, dict) and "message" in detail:
        extra_details = {key: value for key, value in detail.items() if key != "message"}
        content = {
            "code": _default_error_code(status_code),
            "message": str(detail["message"]),
        }
        if extra_details:
            content["details"] = extra_details
        return content
    return {
        "code": _default_error_code(status_code),
        "message": str(detail),
    }


def _default_error_code(status_code: int) -> str:
    match status_code:
        case 401:
            return "unauthorized"
        case 404:
            return "not_found"
        case 422:
            return "validation_error"
        case 503:
            return "provider_unavailable"
        case _:
            return "request_error"
