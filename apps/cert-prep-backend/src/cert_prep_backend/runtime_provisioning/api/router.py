from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status

from cert_prep_backend.ai_providers.application import use_cases as ai_providers
from cert_prep_backend.ai_providers.application.ports import MachineInventory
from cert_prep_backend.ai_providers.api.schemas import MachineInventoryRead
from cert_prep_backend.runtime_provisioning.application import use_cases as runtime_installations
from cert_prep_backend.runtime_provisioning.application.ports import RuntimeInstallation
from cert_prep_backend.runtime_provisioning.api.schemas import (
    RuntimeInstallationRead,
    RuntimeRequirementsRead,
)
from cert_prep_backend.api.errors import (
    api_error,
    not_found_error,
)
from cert_prep_backend.platform.errors import OperationNotCancellableError, ProviderUnavailableError
from cert_prep_contracts.runtime import RuntimeRequirementKind


router = APIRouter(prefix="/runtime", tags=["runtime"])


def get_runtime_installation_manager(request: Request) -> RuntimeInstallation:
    return request.app.state.runtime_installation_manager


def get_machine_inventory(request: Request) -> MachineInventory:
    return request.app.state.machine_inventory


@router.get("/requirements", response_model=RuntimeRequirementsRead)
def runtime_requirements(
    manager: RuntimeInstallation = Depends(get_runtime_installation_manager),
):
    return {"items": runtime_installations.list_runtime_requirements(manager)}


@router.get("/machine-inventory", response_model=MachineInventoryRead)
def machine_inventory(
    refresh: bool = False,
    machine: MachineInventory = Depends(get_machine_inventory),
):
    return ai_providers.inspect_machine(machine, refresh=refresh)


@router.post(
    "/installations/{kind}",
    response_model=RuntimeInstallationRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_runtime_installation(
    kind: RuntimeRequirementKind,
    manager: RuntimeInstallation = Depends(get_runtime_installation_manager),
):
    try:
        return runtime_installations.start_runtime_installation(manager, kind)
    except ProviderUnavailableError as exc:
        raise api_error(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="provider_unavailable",
            message=str(exc),
        ) from exc


@router.get("/installations/{job_id}", response_model=RuntimeInstallationRead)
def get_runtime_installation(
    job_id: str,
    manager: RuntimeInstallation = Depends(get_runtime_installation_manager),
):
    try:
        return runtime_installations.view_runtime_installation(manager, job_id)
    except KeyError as exc:
        raise not_found_error("Runtime installation job was not found.") from exc


@router.delete("/installations/{job_id}", response_model=RuntimeInstallationRead)
def cancel_runtime_installation(
    job_id: str,
    manager: RuntimeInstallation = Depends(get_runtime_installation_manager),
):
    try:
        return runtime_installations.cancel_runtime_installation(manager, job_id)
    except KeyError as exc:
        raise not_found_error("Runtime installation job was not found.") from exc
    except OperationNotCancellableError as exc:
        raise api_error(
            status_code=status.HTTP_409_CONFLICT,
            code="operation_not_cancellable",
            message=str(exc),
        ) from exc
