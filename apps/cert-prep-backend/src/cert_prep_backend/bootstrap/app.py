import logging
import platform
import sqlite3
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from cert_prep_ollama.server_coordinator import OllamaServerCoordinator
from threading import RLock

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

from cert_prep_backend import __version__
from cert_prep_backend.ai_providers.infrastructure.llm_installers import configured_installer_choices
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.database import Database
from cert_prep_backend.llm_provisioning.application.ports import LLMInstallation, LLMInstaller
from cert_prep_backend.llm_provisioning.infrastructure.installers import (
    ConfiguredLLMInstallers,
    LLMModelInstaller,
)
from cert_prep_backend.llm_provisioning.infrastructure.manager import ThreadLLMInstallationWork
from cert_prep_backend.llm_provisioning.infrastructure.repository import (
    LLMInstallationJobRepository,
)
from cert_prep_backend.api.auth import require_bearer_auth
from cert_prep_backend.platform.change_notifications import DatabaseChangeNotifier
from cert_prep_backend.capture_integration.infrastructure.client import CaptureRuntimeClient
from cert_prep_backend.capture_integration.infrastructure.runtime_policy import (
    CAPTURE_DOCUMENT_SCHEMA_VERSION,
    SUPPORTED_API_VERSION,
    SUPPORTED_RUNTIME_VERSION,
)
from cert_prep_backend.capture_integration.application import use_cases as capture_reviews
from cert_prep_backend.capture_integration.infrastructure.background import (
    PoolCaptureBackgroundWork,
)
from cert_prep_backend.capture_integration.infrastructure.coordinator import (
    CertPrepCaptureCoordinator,
)
from cert_prep_backend.capture_integration.infrastructure.document_extraction import (
    CaptureSourceExtraction,
)
from cert_prep_backend.capture_integration.infrastructure.review_sessions import (
    CaptureReviewStoreAdapter,
)
from cert_prep_backend.capture_integration.infrastructure.review_workflow import (
    CaptureReviewMaintenanceAdapter,
    CaptureReviewWorkflowAdapter,
)
from cert_prep_backend.capture_integration.infrastructure.runtime_gateway import (
    CoordinatorCaptureRuntime,
)
from cert_prep_backend.capture_integration.infrastructure.runtime_setup import (
    ClientCaptureRuntimeSetup,
)
from cert_prep_backend.capture_integration.infrastructure.structuring import (
    CertPrepCaptureStructuringAdapter,
)
from cert_prep_backend.ai_providers.domain.provider import LLMProvider
from cert_prep_backend.ai_providers.application.ports import MachineInventory
from cert_prep_backend.ai_providers.infrastructure.machine_inventory import OllamaMachineInventory
from cert_prep_backend.ai_providers.infrastructure.device_preference_repository import (
    SqliteDevicePreferenceRepository,
)
from cert_prep_backend.ai_providers.infrastructure.ollama_server import (
    ollama_server_coordinator_from_settings,
)
from cert_prep_backend.ai_providers.infrastructure.provider import lazy_provider_from_settings
from cert_prep_backend.authoring.infrastructure.question_writing import ProviderQuestionWriting
from cert_prep_backend.authoring.infrastructure.import_questions import ImportedDocumentQuestionGeneration
from cert_prep_backend.authoring.infrastructure.sources import SourceLibraryQuestionSources
from cert_prep_backend.authoring.infrastructure.sudachi_reading_lexicon import SudachiReadingLexicon
from cert_prep_backend.authoring.infrastructure.question_jobs import (
    QuestionJobScheduler,
    QuestionJobWork,
)
from cert_prep_backend.llm_provisioning.application import use_cases as llm_installations
from cert_prep_backend.source_library.application import use_cases as source_library
from cert_prep_backend.source_library.infrastructure.storage import LocalSourceFileStore
from cert_prep_backend.source_library.infrastructure.worker_pool import PoolDocumentWork
from cert_prep_backend.platform.document_worker_pool import (
    DocumentWorkerPool,
)
from cert_prep_backend.capture_integration.api import (
    runtime_router as capture_runtime,
    router as capture_workbench,
)
from cert_prep_backend.source_library.api import (
    operation_events as document_operation_events,
    router as documents,
)
from cert_prep_backend.ai_providers.api import router as llm
from cert_prep_backend.llm_provisioning.api import router as llm_provisioning
from cert_prep_backend.llm_provisioning.api import (
    operation_events as llm_installation_events,
)
from cert_prep_backend.authoring.api import router as questions
from cert_prep_backend.authoring.api import operation_events as question_generation_events
from cert_prep_backend.practice.api import router as practice
from cert_prep_backend.bootstrap.authoring_links import (
    authoring_documents,
    bind_document_question_count,
    question_generation_job_repository,
    question_repository,
)
from cert_prep_backend.bootstrap.capture_links import (
    bind_capture_review_commit,
    capture_operations,
    capture_publication,
)
from cert_prep_backend.bootstrap.practice_reads import bind_practice_reads, practice_documents
from cert_prep_backend.bootstrap.source_library_links import (
    chunk_translator,
    document_operation_repository,
    document_repository,
)
from cert_prep_backend.bootstrap.study_projects import authoring_projects
from cert_prep_backend.practice.infrastructure.repository import SqlitePracticeStore
from cert_prep_backend.projects.api import router as projects
from cert_prep_backend.projects.infrastructure.repository import SqliteProjectRepository


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
    llm_installation_manager: LLMInstallation | None = None,
    llm_installation_async_jobs: bool = True,
    document_processing_async_jobs: bool = True,
    background_question_jobs: bool = True,
    capture_runtime_client: CaptureRuntimeClient | None = None,
) -> FastAPI:
    app_settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        try:
            app.state.document_worker_pool.start()
            yield
        finally:
            capture_reviews.recover_capture_reviews(app.state.capture_review_maintenance)
            app.state.document_worker_pool.close(join_timeout_seconds=0)
            close_result = app.state.document_worker_pool.close(
                join_timeout_seconds=DOCUMENT_WORKER_JOIN_TIMEOUT_SECONDS
            )
            if close_result.unresolved_operation_ids:
                logger.error(
                    "Document worker shutdown retained unresolved cancellations: "
                    "operation_ids=%s",
                    ",".join(close_result.unresolved_operation_ids),
                    extra={"operation_ids": close_result.unresolved_operation_ids},
                )
            llm_installations.stop_llm_installations(app.state.llm_installation_manager)
            app.state.question_job_scheduler.close()
            llm_provider_close = getattr(app.state.llm_provider, "close", None)
            if callable(llm_provider_close):
                llm_provider_close()
            ollama_server = getattr(app.state, "ollama_server", None)
            if ollama_server is not None:
                ollama_server.close()
            if app.state.owns_capture_runtime_client:
                app.state.capture_runtime_client.close()

    app = FastAPI(
        title="Cert Prep Backend",
        version=__version__,
        summary="Local sidecar API for the cert prep desktop app.",
        lifespan=lifespan,
    )
    app.state.settings = app_settings
    app.state.database_change_notifier = DatabaseChangeNotifier()
    app.state.database = Database(
        app_settings,
        change_notifier=app.state.database_change_notifier,
    )
    app.state.project_repository = SqliteProjectRepository(app.state.database)
    app.state.practice_store = SqlitePracticeStore(
        app.state.database,
        bind_reads=lambda connection: bind_practice_reads(app.state.database, connection),
        documents=practice_documents(app.state.database),
    )
    app.state.document_repository = document_repository(app.state.database)
    app.state.document_operation_repository = document_operation_repository(app.state.database)
    app.state.source_file_store = LocalSourceFileStore(app_settings)
    source_library.recover_interrupted_work(
        app.state.document_operation_repository, app.state.document_repository
    )
    app.state.machine_inventory = OllamaMachineInventory(app_settings)
    app.state.device_preference_repository = SqliteDevicePreferenceRepository(app.state.database)
    app.state.ollama_server = ollama_server_coordinator_from_settings(
        app_settings,
        app.state.machine_inventory,
        preferences=app.state.device_preference_repository,
    )
    app.state.chunk_translator = chunk_translator(
        app.state.database,
        app_settings,
        server=app.state.ollama_server,
    )
    app.state.llm_provider = llm_provider or lazy_provider_from_settings(
        app_settings, server=app.state.ollama_server
    )
    app.state.capture_runtime_client = capture_runtime_client or _capture_runtime_client(
        app_settings
    )
    app.state.owns_capture_runtime_client = (
        capture_runtime_client is None and app.state.capture_runtime_client is not None
    )
    app.state.capture_runtime_setup = (
        ClientCaptureRuntimeSetup(app.state.capture_runtime_client)
        if app.state.capture_runtime_client is not None
        else None
    )
    app.state.capture_coordinator = (
        CertPrepCaptureCoordinator(
            client=app.state.capture_runtime_client,
            structurer=CertPrepCaptureStructuringAdapter(
                app.state.llm_provider,
                app.state.capture_runtime_client,
            ),
            reconciliation_interval_seconds=(
                app_settings.capture_runtime_reconciliation_interval_seconds
            ),
            timeout_seconds=app_settings.capture_runtime_job_timeout_seconds,
        )
        if app.state.capture_runtime_client is not None
        else None
    )
    app.state.capture_review_store = CaptureReviewStoreAdapter(app.state.database)
    app.state.capture_review_workflow = CaptureReviewWorkflowAdapter(
        app.state.database,
        app.state.capture_coordinator,
        app.state.document_operation_repository,
        documents=app.state.document_repository,
        publication=capture_publication(app.state.database),
        bind_commit=bind_capture_review_commit(),
        operations=capture_operations(
            app.state.database, app.state.document_operation_repository
        ),
    )
    app.state.capture_review_maintenance = CaptureReviewMaintenanceAdapter(
        app.state.database,
        app.state.capture_coordinator,
        app.state.document_operation_repository,
    )
    app.state.capture_runtime = (
        CoordinatorCaptureRuntime(
            app.state.capture_coordinator,
            app.state.capture_runtime_client,
        )
        if app.state.capture_coordinator is not None
        else None
    )
    app.state.capture_runtime_event_registry = capture_workbench.CaptureRuntimeEventRegistry()
    capture_reviews.recover_capture_reviews(app.state.capture_review_maintenance)
    app.state.document_worker_pool = DocumentWorkerPool(
        app_settings.document_processing_parallelism,
        worker_name_prefix="capture-document-worker",
    )
    app.state.capture_background_work = PoolCaptureBackgroundWork(app.state.document_worker_pool)
    app.state.document_work = PoolDocumentWork(app.state.document_worker_pool)
    app.state.source_extraction = (
        CaptureSourceExtraction(
            app.state.capture_coordinator,
            publication=capture_publication(app.state.database),
        )
        if app.state.capture_coordinator is not None
        else None
    )
    app.state.document_processing_async_jobs = document_processing_async_jobs
    app.state.llm_installation_async_jobs = llm_installation_async_jobs
    reading_lexicon = SudachiReadingLexicon() if app_settings.reading_solver_enabled else None
    app.state.question_sources = SourceLibraryQuestionSources(app.state.document_repository)
    app.state.question_job_scheduler = QuestionJobScheduler(
        settings=app_settings,
        provider=app.state.llm_provider,
        async_jobs=background_question_jobs,
        reading_lexicon=reading_lexicon,
        question_count=bind_document_question_count(app.state.database),
        sources=app.state.question_sources,
        projects=authoring_projects(app.state.database),
        documents=authoring_documents(app.state.database),
    )
    app.state.question_job_scheduler.recover_jobs(app.state.database)
    app.state.question_repository = question_repository(app.state.database)
    app.state.question_generation_job_repository = question_generation_job_repository(
        app.state.database
    )
    app.state.question_generation_work = QuestionJobWork(
        app.state.question_job_scheduler, app.state.database
    )
    app.state.question_writing = ProviderQuestionWriting(reading_lexicon=reading_lexicon)
    app.state.imported_question_generation = ImportedDocumentQuestionGeneration(
        work=app.state.question_generation_work,
        questions=app.state.question_repository,
        sources=app.state.question_sources,
        writing=app.state.question_writing,
        model=app.state.llm_provider,
        settings=app_settings,
    )
    app.state.machine_inventory = OllamaMachineInventory(app_settings)
    if llm_installation_manager:
        app.state.llm_installation_manager = llm_installation_manager
    else:
        app.state.llm_installation_manager = build_llm_installation(
            settings=app_settings,
            llm_provider=app.state.llm_provider,
            machine_inventory=app.state.machine_inventory,
            db=app.state.database,
            async_jobs=llm_installation_async_jobs,
            server=app.state.ollama_server,
        )
        llm_installations.recover_llm_installations(app.state.llm_installation_manager)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=app_settings.allowed_origins,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "Last-Event-ID",
            "X-Cert-Prep-Operation-Id",
            "X-Idempotency-Key",
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
    app.include_router(questions.documents_router, dependencies=protected_dependencies)
    app.include_router(questions.question_jobs_router, dependencies=protected_dependencies)
    app.include_router(questions.manual_operations_router, dependencies=protected_dependencies)
    app.include_router(questions.questions_router, dependencies=protected_dependencies)
    app.include_router(practice.router, dependencies=protected_dependencies)
    app.include_router(llm.router, dependencies=protected_dependencies)
    app.include_router(llm_provisioning.router, dependencies=protected_dependencies)
    app.include_router(capture_runtime.router, dependencies=protected_dependencies)
    app.include_router(capture_workbench.router, dependencies=protected_dependencies)
    # The operation event streams keep their place at the end of the API (D6).
    app.include_router(document_operation_events.router, dependencies=protected_dependencies)
    app.include_router(question_generation_events.router, dependencies=protected_dependencies)
    app.include_router(llm_installation_events.router, dependencies=protected_dependencies)

    return app


def _capture_runtime_client(settings: Settings) -> CaptureRuntimeClient | None:
    if not settings.capture_runtime_configured:
        return None
    expected = {
        "runtime": (settings.capture_runtime_version, SUPPORTED_RUNTIME_VERSION),
        "API": (settings.capture_runtime_api_version, SUPPORTED_API_VERSION),
        "schema": (
            settings.capture_document_schema_version,
            CAPTURE_DOCUMENT_SCHEMA_VERSION,
        ),
    }
    mismatches = [
        f"{label} {actual!r} (expected {wanted!r})"
        for label, (actual, wanted) in expected.items()
        if actual != wanted
    ]
    if mismatches:
        raise ValueError("Incompatible staged Capture Runtime: " + "; ".join(mismatches))
    assert settings.capture_runtime_url is not None
    assert settings.capture_runtime_token is not None
    return CaptureRuntimeClient(
        base_url=settings.capture_runtime_url,
        bearer_token=settings.capture_runtime_token,
    )


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


def build_llm_installation(
    *,
    settings: Settings,
    llm_provider: object,
    machine_inventory: MachineInventory,
    db: Database | None = None,
    async_jobs: bool = True,
    installers: list[LLMInstaller] | None = None,
    server: OllamaServerCoordinator | None = None,
) -> LLMInstallation:
    """Bootstrap concrete provider adapters into runtime-owned application ports."""
    runtimes, model = configured_installer_choices(
        settings,
        llm_provider,
        machine_inventory,
        lambda: LLMModelInstaller(llm_provider),
        server=server,
    )
    catalog = ConfiguredLLMInstallers([*runtimes, model], model.kind, installers)
    lock = RLock()
    work = ThreadLLMInstallationWork(lock, async_jobs=async_jobs)
    jobs = LLMInstallationJobRepository(db=db, lock=lock, on_evict=work.forget)
    return LLMInstallation(jobs, catalog, work, work.clock, work.new_id)
