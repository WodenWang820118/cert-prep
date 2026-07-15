from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status

from cert_prep_backend.api.dependencies import (
    get_llm_provider,
    get_database,
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
    FastFlowLMTermsDecisionRequest,
    LLMHealthRead,
    LLMProviderSelectionRead,
    ModelDownloadRead,
    OllamaProfileSelectionRead,
    OllamaProfilesRead,
)
from cert_prep_backend.domains.mock_exams.provider_preferences import (
    persist_fastflowlm_terms_decision,
)
from cert_prep_backend.domains.mock_exams.provider_selection import (
    provider_selection_from_settings,
)
from cert_prep_backend.domains.runtime_installations import RuntimeInstallationManager
from cert_prep_backend.domains.runtime_schemas import RuntimeInstallationStartRequest
from cert_prep_backend.api.errors import (
    ProviderUnavailableError,
    TermsAcceptanceRequiredError,
    api_error,
    not_found_error,
)
from cert_prep_backend.core.exceptions import OperationNotCancellableError
from cert_prep_contracts.llm import FASTFLOWLM_RUNTIME_TRUST_POLICY
from cert_prep_backend.persistence.database import Database


router = APIRouter(prefix="/llm", tags=["llm"])


@router.get("/health", response_model=LLMHealthRead)
def llm_health(provider: LLMProvider = Depends(get_llm_provider)):
    return provider.health()


@router.get("/provider-selection", response_model=LLMProviderSelectionRead)
def llm_provider_selection(
    settings: Settings = Depends(get_settings),
    provider: LLMProvider = Depends(get_llm_provider),
):
    return _provider_selection_response(settings, provider)


@router.post(
    "/provider-selection/fastflowlm-terms-decision",
    response_model=LLMProviderSelectionRead,
)
def decide_fastflowlm_terms(
    request: Request,
    payload: FastFlowLMTermsDecisionRequest,
    settings: Settings = Depends(get_settings),
    db: Database = Depends(get_database),
    provider: LLMProvider = Depends(get_llm_provider),
):
    try:
        persist_fastflowlm_terms_decision(
            settings,
            db,
            decision=payload.decision,
            terms_version=payload.terms_version,
        )
    except ValueError as exc:
        raise api_error(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            code="validation_error",
            message=str(exc),
        ) from exc

    reconfigure = getattr(provider, "reconfigure_from_settings", None)
    if callable(reconfigure):
        reconfigure(settings)

    old_manager = request.app.state.runtime_installation_manager
    old_manager.close()
    request.app.state.runtime_installation_manager = RuntimeInstallationManager(
        settings=settings,
        llm_provider=provider,
        ocr_provider=request.app.state.ocr_provider,
        db=db,
        async_jobs=request.app.state.runtime_installation_async_jobs,
    )
    return _provider_selection_response(settings, provider)


def _provider_selection_response(settings: Settings, provider: LLMProvider):
    resolve = getattr(provider, "resolved_provider", None)
    effective_provider = resolve() if callable(resolve) else provider
    return provider_selection_from_settings(
        settings,
        effective_provider=str(getattr(effective_provider, "provider", "")),
        effective_model=str(getattr(effective_provider, "model", "")),
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
    payload: RuntimeInstallationStartRequest | None = None,
    manager: RuntimeInstallationManager = Depends(get_runtime_installation_manager),
):
    try:
        return manager.start_model_installation(
            fastflowlm_terms_accepted_version=(
                payload.fastflowlm_terms_accepted_version if payload else None
            )
        )
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
