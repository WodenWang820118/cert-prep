"""Downloading the configured Ollama model: a Runtime Provisioning installation under /llm."""

from __future__ import annotations

from fastapi import APIRouter, Depends, status

from cert_prep_backend.api.dependencies import get_runtime_installation_manager
from cert_prep_backend.api.errors import (
    api_error,
    not_found_error,
)
from cert_prep_backend.platform.errors import OperationNotCancellableError, ProviderUnavailableError
from cert_prep_backend.runtime_provisioning.api.schemas import ModelDownloadRead
from cert_prep_backend.runtime_provisioning.infrastructure import RuntimeInstallationManager


router = APIRouter(prefix="/llm", tags=["llm"])


@router.post(
    "/model-downloads",
    response_model=ModelDownloadRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_model_download(
    manager=Depends(get_runtime_installation_manager),
):
    try:
        return manager.start_model_installation()
    except ProviderUnavailableError as exc:
        raise api_error(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="provider_unavailable",
            message=str(exc),
        ) from exc


@router.get("/model-downloads/{job_id}", response_model=ModelDownloadRead)
def get_model_download(
    job_id: str,
    manager: RuntimeInstallationManager = Depends(get_runtime_installation_manager),
):
    try:
        return manager.get_installation(job_id)
    except KeyError as exc:
        raise not_found_error("Model download job was not found.") from exc


@router.delete("/model-downloads/{job_id}", response_model=ModelDownloadRead)
def cancel_model_download(
    job_id: str,
    manager: RuntimeInstallationManager = Depends(get_runtime_installation_manager),
):
    try:
        return manager.cancel_installation(job_id)
    except KeyError as exc:
        raise not_found_error("Model download job was not found.") from exc
    except OperationNotCancellableError as exc:
        raise api_error(
            status_code=status.HTTP_409_CONFLICT,
            code="operation_not_cancellable",
            message=str(exc),
        ) from exc
