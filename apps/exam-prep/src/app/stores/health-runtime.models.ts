import type {
  HealthResponse,
  LLMHealthRead,
  ModelDownloadRead,
  OCRHealthRead,
  RuntimeInstallationRead,
  RuntimeRequirementRead,
} from '../exam-prep-api';

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
export type RuntimeKind = 'ollama' | 'ollama_model' | 'paddle_ocr';

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
