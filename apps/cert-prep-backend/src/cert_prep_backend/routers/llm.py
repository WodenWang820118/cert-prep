from __future__ import annotations

from fastapi import APIRouter, Depends, status

from cert_prep_backend.dependencies import get_llm_provider, get_runtime_installation_manager
from cert_prep_backend.domains.mock_exams.ports import DraftGenerationProvider as LLMProvider
from cert_prep_backend.domains.mock_exams.schemas import LLMHealthRead, ModelDownloadRead
from cert_prep_backend.domains.runtime_installations import RuntimeInstallationManager
from cert_prep_backend.errors import ProviderUnavailableError, api_error, not_found_error
from cert_prep_contracts.runtime import RuntimeRequirementKind


router = APIRouter(prefix="/llm", tags=["llm"])


@router.get("/health", response_model=LLMHealthRead)
def llm_health(provider: LLMProvider = Depends(get_llm_provider)):
    return provider.health()


@router.post(
    "/model-downloads",
    response_model=ModelDownloadRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_model_download(
    manager: RuntimeInstallationManager = Depends(get_runtime_installation_manager),
):
    try:
        return manager.start_installation(RuntimeRequirementKind.OLLAMA_MODEL)
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
