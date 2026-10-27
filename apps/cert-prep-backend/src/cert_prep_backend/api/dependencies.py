from __future__ import annotations

import hmac

from fastapi import Depends, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from cert_prep_backend.api.errors import api_error
from cert_prep_backend.platform.dependencies import get_settings
from cert_prep_backend.capture_integration.infrastructure.client import CaptureRuntimeClient
from cert_prep_backend.capture_integration.infrastructure.coordinator import CertPrepCaptureCoordinator
from cert_prep_backend.ai_providers.domain.provider import LLMProvider
from cert_prep_backend.authoring.infrastructure.streaming import StreamingDraftGenerationManager
from cert_prep_backend.runtime_provisioning.infrastructure import RuntimeInstallationManager
from cert_prep_backend.platform.document_worker_pool import (
    DocumentWorkerPool,
)


bearer_scheme = HTTPBearer(auto_error=False)


def get_capture_runtime_client(request: Request) -> CaptureRuntimeClient:
    client: CaptureRuntimeClient | None = request.app.state.capture_runtime_client
    if client is None:
        raise api_error(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="capture_runtime_unavailable",
            message="Capture Runtime is not configured for this process.",
        )
    return client


def get_capture_coordinator(request: Request) -> CertPrepCaptureCoordinator:
    coordinator: CertPrepCaptureCoordinator | None = request.app.state.capture_coordinator
    if coordinator is None:
        raise api_error(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="capture_runtime_unavailable",
            message="Capture Runtime is not configured for this process.",
        )
    return coordinator


def get_llm_provider(request: Request) -> LLMProvider:
    return request.app.state.llm_provider


def get_runtime_installation_manager(request: Request) -> RuntimeInstallationManager:
    return request.app.state.runtime_installation_manager


def get_streaming_draft_generation_manager(
    request: Request,
) -> StreamingDraftGenerationManager:
    return request.app.state.streaming_draft_generation_manager


def get_document_worker_pool(request: Request) -> DocumentWorkerPool:
    return request.app.state.document_worker_pool


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
