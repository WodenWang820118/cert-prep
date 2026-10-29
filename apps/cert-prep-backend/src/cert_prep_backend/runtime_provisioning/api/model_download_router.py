"""Downloading the configured Ollama model: a Runtime Provisioning installation under /llm."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status

from cert_prep_backend.api.errors import (
    api_error,
    not_found_error,
)
from cert_prep_backend.platform.errors import OperationNotCancellableError, ProviderUnavailableError
from cert_prep_backend.runtime_provisioning.api.schemas import ModelDownloadRead
from cert_prep_backend.runtime_provisioning.application import use_cases as runtime_installations
from cert_prep_backend.runtime_provisioning.application.ports import RuntimeInstallation


router = APIRouter(prefix="/llm", tags=["llm"])


def get_runtime_installation_manager(request: Request) -> RuntimeInstallation:
    return request.app.state.runtime_installation_manager


@router.post(
    "/model-downloads",
    response_model=ModelDownloadRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_model_download(
    manager=Depends(get_runtime_installation_manager),
):
    try:
        return runtime_installations.download_selected_model(manager)
    except ProviderUnavailableError as exc:
        raise api_error(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="provider_unavailable",
            message=str(exc),
        ) from exc


@router.get("/model-downloads/{job_id}", response_model=ModelDownloadRead)
def get_model_download(
    job_id: str,
    manager: RuntimeInstallation = Depends(get_runtime_installation_manager),
):
    try:
        return runtime_installations.view_runtime_installation(manager, job_id)
    except KeyError as exc:
        raise not_found_error("Model download job was not found.") from exc


@router.delete("/model-downloads/{job_id}", response_model=ModelDownloadRead)
def cancel_model_download(
    job_id: str,
    manager: RuntimeInstallation = Depends(get_runtime_installation_manager),
):
    try:
        return runtime_installations.cancel_runtime_installation(manager, job_id)
    except KeyError as exc:
        raise not_found_error("Model download job was not found.") from exc
    except OperationNotCancellableError as exc:
        raise api_error(
            status_code=status.HTTP_409_CONFLICT,
            code="operation_not_cancellable",
            message=str(exc),
        ) from exc
