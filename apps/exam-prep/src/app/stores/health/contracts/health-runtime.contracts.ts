import type {
  HealthResponse,
  LLMHealthRead,
  ModelDownloadRead,
  OCRHealthRead,
  RuntimeInstallationRead,
  RuntimeRequirementRead,
} from '../../../exam-prep-api';

/**
 * Runtime job lifecycle normalized for UI state and polling decisions.
 */
export type DownloadPhase =
  | 'starting'
  | 'running'
  | 'waiting_for_user'
  | 'succeeded'
  | 'failed';

/**
 * Runtime requirement kinds the Angular health UI knows how to present.
 */
export type RuntimeKind =
  | 'ollama'
  | 'ollama_model'
  | 'paddle_ocr'
  | 'directml_ocr'
  | 'amd_npu_ocr';

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
  readonly runtimeRequirements: RuntimeRequirementRead[];
}

/**
 * Minimal model-download API surface used by the Angular health workflow.
 */
export interface ModelDownloadApiClient {
  startModelDownload(): Promise<ModelDownloadRead>;
  getModelDownload(jobId: string): Promise<ModelDownloadRead>;
}

/**
 * Minimal runtime-installation API surface used by the Angular health workflow.
 */
export interface RuntimeInstallationApiClient {
  runtimeRequirements(): Promise<{ items: RuntimeRequirementRead[] }>;
  startRuntimeInstallation(kind: string): Promise<RuntimeInstallationRead>;
  getRuntimeInstallation(jobId: string): Promise<RuntimeInstallationRead>;
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
}

/**
 * Loose record shape used when normalizing runtime job responses from evolving
 * backend and Tauri command contracts.
 */
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

/**
 * Backends may expose model-missing details under several diagnostic fields
 * while the OpenAPI contract stabilizes.
 */
export type LLMHealthWithMissingReason = LLMHealthRead &
  Partial<{
    code: string;
    error_code: string;
    reason: string;
    unavailable_reason: string;
  }>;
