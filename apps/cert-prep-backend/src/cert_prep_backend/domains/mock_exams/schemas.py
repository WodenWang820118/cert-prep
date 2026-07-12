from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from cert_prep_backend.domains.runtime_schemas import MachineInventoryRead
from cert_prep_backend.domains.exam_content import QuestionItemKind, QuestionItemKindValue
from cert_prep_backend.domains.mock_exams.models import (
    AnswerKeySource,
    AnswerKeySourceValue,
    DraftGenerationStrategy,
    DraftStatusValue,
)
from cert_prep_contracts.llm import (
    FastFlowLMTermsDecision,
    LLMProviderName,
    LLMProviderPreference,
)
from cert_prep_contracts.runtime import RuntimeRequirementKind


class DraftGenerateRequest(BaseModel):
    limit: int = Field(default=5, ge=1, le=50)
    strategy: DraftGenerationStrategy = DraftGenerationStrategy.DETERMINISTIC_ONLY


class QuestionDraftCreate(BaseModel):
    question: str = ""
    choices: list[str] = Field(default_factory=list)
    answer: str | None = None
    answer_key_source: AnswerKeySourceValue = AnswerKeySource.MANUAL
    rationale: str | None = None
    citation_page: int | None = Field(default=None, ge=1)
    source_excerpt: str | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    document_id: str | None = None
    chunk_id: str | None = None
    source_order: int | None = Field(default=None, ge=0)
    source_question_number: str | None = None
    item_kind: QuestionItemKindValue = QuestionItemKind.UNKNOWN
    group_key: str | None = None
    group_prompt: str | None = None


class QuestionDraftUpdate(BaseModel):
    question: str | None = None
    choices: list[str] | None = None
    answer: str | None = None
    answer_key_source: AnswerKeySourceValue | None = None
    rationale: str | None = None
    citation_page: int | None = Field(default=None, ge=1)
    source_excerpt: str | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    source_order: int | None = Field(default=None, ge=0)
    source_question_number: str | None = None
    item_kind: QuestionItemKindValue | None = None
    group_key: str | None = None
    group_prompt: str | None = None


class QuestionDraftRead(BaseModel):
    id: str
    project_id: str
    document_id: str | None
    chunk_id: str | None
    question: str
    choices: list[str]
    answer: str | None
    answer_key_source: AnswerKeySourceValue
    rationale: str | None
    citation_page: int | None
    source_excerpt: str | None
    confidence: float | None
    source_order: int | None
    source_question_number: str | None
    item_kind: QuestionItemKindValue
    group_key: str | None
    group_prompt: str | None
    status: DraftStatusValue
    rejection_reason: str | None
    created_at: str
    updated_at: str


class QuestionDraftList(BaseModel):
    items: list[QuestionDraftRead]


class DraftGenerationJobRead(BaseModel):
    id: str
    project_id: str
    document_id: str
    chunk_id: str
    page_number: int
    strategy: DraftGenerationStrategy
    status: str
    provider: str
    model: str
    effective_provider: str | None
    effective_model: str | None
    fallback_reason: str | None
    generated_count: int
    retry_count: int
    last_error: str | None
    created_at: str
    updated_at: str


class DraftGenerationJobList(BaseModel):
    items: list[DraftGenerationJobRead]


class LLMHealthRead(BaseModel):
    provider: str
    model: str
    available: bool
    detail: str
    unavailable_reason: str | None = None
    configured_model: str | None = None
    effective_model: str | None = None
    fallback_models: list[str] = Field(default_factory=list)
    fallback_reason: str | None = None
    profile_id: str | None = None
    base_model: str | None = None
    modelfile_sha256: str | None = None
    profile_reason: str | None = None
    profile_warnings: list[str] = Field(default_factory=list)


class LLMProviderSelectionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    preference: LLMProviderPreference
    selected_provider: LLMProviderName
    effective_provider: LLMProviderName
    configured_model: str
    effective_model: str
    selection_reason: str
    fallback_reason: str | None = None
    hardware_compatible: bool
    requires_terms_acceptance: bool
    terms_accepted: bool
    terms_version: str | None = None
    terms_url: str | None = None
    runtime_requirement_kind: RuntimeRequirementKind | None = None
    model_requirement_kind: RuntimeRequirementKind | None = None


class FastFlowLMTermsDecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: FastFlowLMTermsDecision
    terms_version: str


class OllamaModelProfileRead(BaseModel):
    profile_id: str
    display_name: str
    description: str
    base_model: str
    local_model: str
    context_window: int
    system_prompt: str
    parameters: dict[str, str | int | float | bool] = Field(default_factory=dict)
    min_total_ram_bytes: int | None = None
    min_available_ram_bytes: int | None = None
    min_free_disk_bytes: int | None = None
    min_vram_bytes: int | None = None
    auto_selectable: bool
    explicit_opt_in_required: bool
    fallback_profile_ids: list[str] = Field(default_factory=list)


class OllamaProfilesRead(BaseModel):
    items: list[OllamaModelProfileRead]


class OllamaProfileSelectionRead(BaseModel):
    profile_enabled: bool
    profile_id: str | None = None
    selected_profile: OllamaModelProfileRead | None = None
    support_status: str
    reason: str
    fallback_profiles: list[OllamaModelProfileRead] = Field(default_factory=list)
    fallback_models: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    inventory: MachineInventoryRead | None = None
    modelfile_sha256: str | None = None
    effective_model: str
    base_model: str | None = None


class ModelDownloadRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    provider: str
    model: str
    status: str
    detail: str
    completed: int | None
    total: int | None
    created_at: str
    updated_at: str
    error: str | None = None
