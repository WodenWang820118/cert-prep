import type {
  HealthResponse,
  LLMHealthRead,
  ModelDownloadRead,
  OCRHealthRead,
  RuntimeInstallationRead,
  RuntimeRequirementRead,
} from '../../../cert-prep-api';
import type {
  FastFlowLMTermsDecisionRequest as GeneratedFastFlowLMTermsDecisionRequest,
  LLMProviderSelectionRead as GeneratedLLMProviderSelectionRead,
  RuntimeInstallationStartRequest as GeneratedRuntimeInstallationStartRequest,
} from '@cert-prep/api';

/**
 * Runtime job lifecycle normalized for UI state and polling decisions.
 */
export type DownloadPhase =
  | 'starting'
  | 'running'
  | 'cancel_requested'
  | 'canceled'
  | 'waiting_for_user'
  | 'succeeded'
  | 'failed';

/**
 * Runtime requirement kinds the Angular health UI knows how to present.
 */
export type RuntimeKind =
  | 'ollama'
  | 'ollama_model'
  | 'fastflowlm'
  | 'fastflowlm_model'
  | 'paddle_ocr'
  | 'windowsml_ocr';

/**
 * Backend-owned provider decision and consent request types generated from
 * the shared OpenAPI contract.
 */
export type LLMProviderSelectionRead = GeneratedLLMProviderSelectionRead;
export type FastFlowTermsDecisionRequest =
  GeneratedFastFlowLMTermsDecisionRequest;
export type RuntimeInstallationStartRequest =
  GeneratedRuntimeInstallationStartRequest;

export interface FastFlowTermsConsent {
  readonly version: string;
  readonly url: string;
}

/**
 * Coarse OCR readiness phase used by the runtime UI and upload gating.
 */
export type OcrHealthPhase =
  | 'waiting'
  | 'checking'
  | 'warming'
  | 'stale'
  | 'ready'
  | 'failed';

/**
 * Partial health payload that preserves successful endpoint reads when one
 * optional endpoint fails.
 */
export interface HealthSnapshot {
  readonly system?: HealthResponse;
  readonly llm?: LLMHealthRead;
  readonly ocr?: OCRHealthRead;
  readonly providerSelection?: LLMProviderSelectionRead;
  readonly runtimeRequirements: RuntimeRequirementRead[];
}

/**
 * Provider-selection and FastFlow terms-decision API surface used by health.
 */
export interface LLMProviderSelectionApiClient {
  llmProviderSelection(): Promise<LLMProviderSelectionRead>;
  decideFastflowlmTerms(
    body: FastFlowTermsDecisionRequest,
  ): Promise<LLMProviderSelectionRead>;
}

/**
 * Minimal model-download API surface used by the Angular health workflow.
 */
export interface ModelDownloadApiClient {
  startModelDownload(
    body?: RuntimeInstallationStartRequest,
  ): Promise<ModelDownloadRead>;
  getModelDownload(jobId: string): Promise<ModelDownloadRead>;
  cancelModelDownload(jobId: string): Promise<ModelDownloadRead>;
}

/**
 * Minimal runtime-installation API surface used by the Angular health workflow.
 */
export interface RuntimeInstallationApiClient {
  runtimeRequirements(): Promise<{ items: RuntimeRequirementRead[] }>;
  startRuntimeInstallation(
    kind: string,
    body?: RuntimeInstallationStartRequest,
  ): Promise<RuntimeInstallationRead>;
  getRuntimeInstallation(jobId: string): Promise<RuntimeInstallationRead>;
  cancelRuntimeInstallation(jobId: string): Promise<RuntimeInstallationRead>;
}

/**
 * View model for one backend model-download job.
 */
export interface ModelDownloadView {
  readonly jobId: string | null;
  readonly model: string;
  readonly phase: DownloadPhase;
  readonly status: string;
  readonly progress: number | null;
  readonly message: string;
  readonly error: string | null;
  readonly cancellable: boolean;
}

/**
 * View model for one runtime-installation job.
 */
export interface RuntimeInstallationView {
  readonly jobId: string | null;
  readonly kind: RuntimeKind;
  readonly label: string;
  readonly phase: DownloadPhase;
  readonly status: string;
  readonly progress: number | null;
  readonly message: string;
  readonly error: string | null;
  readonly cancellable: boolean;
}

/** Canonical runtime job payload narrowed defensively at the UI boundary. */
export type RuntimeJobRecord = Record<string, unknown>;

/**
 * Existing UI state needed to preserve job identity while mapping a model
 * download response.
 */
export interface ModelDownloadViewContext {
  readonly currentJobId: string | null;
  readonly modelName: string | null | undefined;
}

/**
 * Existing UI state needed to preserve job identity while mapping a runtime
 * installation response.
 */
export interface RuntimeInstallationViewContext {
  readonly currentJobId: string | null;
}
