from __future__ import annotations

from fastapi import APIRouter, Depends, status

from cert_prep_backend.api.dependencies import (
    get_llm_provider,
    get_runtime_installation_manager,
    get_settings,
)
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.mock_exams.ollama_profiles import (
    profile_catalog_payload,
    profile_selection_payload,
)
from cert_prep_backend.domains.mock_exams.ports import DraftGenerationProvider as LLMProvider
from cert_prep_backend.domains.mock_exams.schemas import (
    LLMHealthRead,
    ModelDownloadRead,
    OllamaProfileSelectionRead,
    OllamaProfilesRead,
)
from cert_prep_backend.domains.runtime_installations import RuntimeInstallationManager
from cert_prep_backend.api.errors import ProviderUnavailableError, api_error, not_found_error


router = APIRouter(prefix="/llm", tags=["llm"])


@router.get("/health", response_model=LLMHealthRead)
def llm_health(provider: LLMProvider = Depends(get_llm_provider)):
    return provider.health()


@router.get("/profiles", response_model=OllamaProfilesRead)
def llm_profiles():
    return profile_catalog_payload()


@router.get("/profile-selection", response_model=OllamaProfileSelectionRead)
def llm_profile_selection(settings: Settings = Depends(get_settings)):
    return profile_selection_payload(settings)


@router.post(
    "/model-downloads",
    response_model=ModelDownloadRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def start_model_download(
    manager: RuntimeInstallationManager = Depends(get_runtime_installation_manager),
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
