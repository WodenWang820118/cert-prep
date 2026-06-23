from __future__ import annotations

import hmac

from fastapi import Depends, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from cert_prep_backend.config import Settings
from cert_prep_backend.database import Database
from cert_prep_backend.errors import api_error
from cert_prep_backend.domains.mock_exams.ports import DraftGenerationProvider as LLMProvider
from cert_prep_backend.domains.mock_exams.streaming import StreamingDraftGenerationManager
from cert_prep_backend.domains.runtime_installations import RuntimeInstallationManager
from cert_prep_backend.domains.source_documents.ocr import OCRProvider


bearer_scheme = HTTPBearer(auto_error=False)


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_database(request: Request) -> Database:
    return request.app.state.database


def get_llm_provider(request: Request) -> LLMProvider:
    return request.app.state.llm_provider


def get_runtime_installation_manager(request: Request) -> RuntimeInstallationManager:
    return request.app.state.runtime_installation_manager


def get_streaming_draft_generation_manager(
    request: Request,
) -> StreamingDraftGenerationManager:
    return request.app.state.streaming_draft_generation_manager


def get_ocr_provider(request: Request) -> OCRProvider:
    return request.app.state.ocr_provider


def require_bearer_auth(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> None:
    settings = get_settings(request)
    if not settings.api_token:
        raise api_error(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="unauthorized",
            message="API token is not configured.",
        )
    if credentials is None or not hmac.compare_digest(credentials.credentials, settings.api_token):
        raise api_error(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="unauthorized",
            message="Bearer token required.",
        )
