from __future__ import annotations

from fastapi import APIRouter, Depends, status

from cert_prep_backend.api.dependencies import (
    get_database,
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
from cert_prep_backend.domains.mock_exams.provider_preferences import (
    persist_fastflowlm_terms_decision,
)
from cert_prep_backend.domains.mock_exams.provider_selection import (
    provider_selection_from_settings,
)
from cert_prep_backend.domains.mock_exams.schemas import (
    FastFlowLMTermsDecisionRequest,
    LLMHealthRead,
    LLMProviderSelectionRead,
    ModelDownloadRead,
    OllamaProfileSelectionRead,
    OllamaProfilesRead,
)
from cert_prep_backend.domains.runtime_installations import RuntimeInstallationManager
from cert_prep_backend.api.errors import (
    ProviderReconfigurationConflictError,
    ProviderUnavailableError,
    TermsAcceptanceRequiredError,
    api_error,
    not_found_error,
)
from cert_prep_backend.persistence.database import Database
from cert_prep_contracts.llm import FASTFLOWLM_RUNTIME_TRUST_POLICY


router = APIRouter(prefix="/llm", tags=["llm"])


@router.get("/health", response_model=LLMHealthRead)
def llm_health(provider: LLMProvider = Depends(get_llm_provider)):
    return provider.health()


@router.get("/provider-selection", response_model=LLMProviderSelectionRead)
def llm_provider_selection(
    settings: Settings = Depends(get_settings),
    provider: LLMProvider = Depends(get_llm_provider),
):
    return provider_selection_from_settings(
        settings,
        effective_provider=str(getattr(provider, "provider", "")),
        effective_model=str(getattr(provider, "model", "")),
    )


@router.post(
    "/provider-selection/fastflowlm-terms-decision",
    response_model=LLMProviderSelectionRead,
)
def decide_fastflowlm_terms(
    payload: FastFlowLMTermsDecisionRequest,
    settings: Settings = Depends(get_settings),
    db: Database = Depends(get_database),
    provider: LLMProvider = Depends(get_llm_provider),
    manager: RuntimeInstallationManager = Depends(get_runtime_installation_manager),
):
    reconfigure_provider = getattr(provider, "reconfigure_from_settings", None)
    if not callable(reconfigure_provider):
        raise api_error(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="provider_unavailable",
            message="Configured LLM provider cannot apply a policy decision at runtime.",
        )

    def apply_policy_decision() -> None:
        persist_fastflowlm_terms_decision(
            settings,
            db,
            decision=payload.decision,
            terms_version=payload.terms_version,
        )
        reconfigure_provider(settings)

    try:
        manager.reconfigure_llm_provider(
            provider,
            apply_policy_decision=apply_policy_decision,
        )
    except ValueError as exc:
        raise api_error(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            code="validation_error",
            message=str(exc),
        ) from exc
    except ProviderReconfigurationConflictError as exc:
        raise api_error(
            status_code=status.HTTP_409_CONFLICT,
            code="provider_reconfiguration_conflict",
            message=str(exc),
        ) from exc
    return provider_selection_from_settings(
        settings,
        effective_provider=str(getattr(provider, "provider", "")),
        effective_model=str(getattr(provider, "model", "")),
    )


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
    except TermsAcceptanceRequiredError as exc:
        raise api_error(
            status_code=status.HTTP_409_CONFLICT,
            code="terms_acceptance_required",
            message=str(exc),
            details={
                "terms_version": FASTFLOWLM_RUNTIME_TRUST_POLICY.version,
                "terms_url": FASTFLOWLM_RUNTIME_TRUST_POLICY.terms_url,
            },
        ) from exc
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
