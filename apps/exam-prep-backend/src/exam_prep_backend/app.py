import sqlite3
from typing import Any

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

from exam_prep_backend import __version__
from exam_prep_backend.config import Settings
from exam_prep_backend.database import Database
from exam_prep_backend.dependencies import require_bearer_auth
from exam_prep_backend.llm import LLMProvider, provider_from_settings
from exam_prep_backend.ocr import OCRProvider, ocr_provider_from_settings
from exam_prep_backend.routers import documents, drafts, llm, ocr, practice, projects


class HealthResponse(BaseModel):
    status: str
    app: str
    version: str


def create_app(
    settings: Settings | None = None,
    llm_provider: LLMProvider | None = None,
    ocr_provider: OCRProvider | None = None,
) -> FastAPI:
    app_settings = settings or Settings()
    app = FastAPI(
        title="Exam Prep Backend",
        version=__version__,
        summary="Local sidecar API for the exam prep desktop app.",
    )
    app.state.settings = app_settings
    app.state.database = Database(app_settings)
    app.state.llm_provider = llm_provider or provider_from_settings(app_settings)
    app.state.ocr_provider = ocr_provider or ocr_provider_from_settings(app_settings)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=app_settings.allowed_origins,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
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
        return HealthResponse(status="ok", app="exam-prep-backend", version=__version__)

    protected_dependencies = [Depends(require_bearer_auth)]
    app.include_router(projects.router, dependencies=protected_dependencies)
    app.include_router(documents.router, dependencies=protected_dependencies)
    app.include_router(drafts.documents_router, dependencies=protected_dependencies)
    app.include_router(drafts.drafts_router, dependencies=protected_dependencies)
    app.include_router(practice.router, dependencies=protected_dependencies)
    app.include_router(llm.router, dependencies=protected_dependencies)
    app.include_router(ocr.router, dependencies=protected_dependencies)

    return app


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
