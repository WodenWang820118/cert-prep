from __future__ import annotations

from fastapi import APIRouter, Depends, status

from cert_prep_backend.dependencies import get_runtime_installation_manager
from cert_prep_backend.domains.runtime_installations import RuntimeInstallationManager
from cert_prep_backend.domains.runtime_schemas import (
    RuntimeInstallationRead,
    RuntimeRequirementsRead,
)
from cert_prep_backend.errors import ProviderUnavailableError, api_error, not_found_error
from cert_prep_contracts.runtime import RuntimeRequirementKind


router = APIRouter(prefix="/runtime", tags=["runtime"])


@router.get("/requirements", response_model=RuntimeRequirementsRead)
def runtime_requirements(
    manager: RuntimeInstallationManager = Depends(get_runtime_installation_manager),
):
    return {"items": manager.requirements()}


@router.post(
    "/installations/{kind}",
    response_model=RuntimeInstallationRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_runtime_installation(
    kind: RuntimeRequirementKind,
    manager: RuntimeInstallationManager = Depends(get_runtime_installation_manager),
):
    try:
        return manager.start_installation(kind)
    except ProviderUnavailableError as exc:
        raise api_error(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="provider_unavailable",
            message=str(exc),
        ) from exc


@router.get("/installations/{job_id}", response_model=RuntimeInstallationRead)
def get_runtime_installation(
    job_id: str,
    manager: RuntimeInstallationManager = Depends(get_runtime_installation_manager),
):
    try:
        return manager.get_installation(job_id)
    except KeyError as exc:
        raise not_found_error("Runtime installation job was not found.") from exc
