from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status

from cert_prep_backend.api.errors import api_error, not_found_error
from cert_prep_backend.llm_provisioning.api.schemas import (
    LLMInstallationRead,
    LLMRequirementsRead,
    StartLLMInstallationRequest,
)
from cert_prep_backend.llm_provisioning.application import use_cases as llm_installations
from cert_prep_backend.llm_provisioning.application.ports import LLMInstallation
from cert_prep_backend.platform.errors import InstallerUnavailable, OperationNotCancellableError
from cert_prep_contracts.llm_installation import LLMRequirementKind


router = APIRouter(prefix="/llm", tags=["llm"])


def get_app_llm_installation(request: Request) -> LLMInstallation:
    return request.app.state.llm_installation


@router.get("/requirements", response_model=LLMRequirementsRead)
def llm_requirements(
    installation: LLMInstallation = Depends(get_app_llm_installation),
):
    return {"items": llm_installations.list_llm_requirements(installation)}


@router.post(
    "/installations",
    response_model=LLMInstallationRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_llm_installation(
    body: StartLLMInstallationRequest,
    installation: LLMInstallation = Depends(get_app_llm_installation),
):
    try:
        if body.kind == LLMRequirementKind.OLLAMA_MODEL:
            return llm_installations.download_selected_model(installation)
        return llm_installations.start_llm_installation(installation, body.kind)
    except InstallerUnavailable as exc:
        raise api_error(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="provider_unavailable",
            message=str(exc),
        ) from exc


@router.get("/installations/{job_id}", response_model=LLMInstallationRead)
def get_llm_installation(
    job_id: str,
    installation: LLMInstallation = Depends(get_app_llm_installation),
):
    try:
        return llm_installations.view_llm_installation(installation, job_id)
    except KeyError as exc:
        raise not_found_error("LLM installation job was not found.") from exc


@router.delete("/installations/{job_id}", response_model=LLMInstallationRead)
def cancel_llm_installation(
    job_id: str,
    installation: LLMInstallation = Depends(get_app_llm_installation),
):
    try:
        return llm_installations.cancel_llm_installation(installation, job_id)
    except KeyError as exc:
        raise not_found_error("LLM installation job was not found.") from exc
    except OperationNotCancellableError as exc:
        raise api_error(
            status_code=status.HTTP_409_CONFLICT,
            code="operation_not_cancellable",
            message=str(exc),
        ) from exc
