import type {
  HealthResponse,
  LLMHealthRead,
  ModelDownloadRead,
  RuntimeInstallationRead,
  RuntimeRequirementRead,
} from '../../../contracts/api.contracts';
import type { LLMProviderSelectionRead as GeneratedLLMProviderSelectionRead } from '../../../contracts/api.contracts';
import type { Observable } from 'rxjs';

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
  | 'ollama_model';

/**
 * Backend-owned provider selection generated from the shared OpenAPI contract.
 */
export type LLMProviderSelectionRead = GeneratedLLMProviderSelectionRead;

/**
 * Partial health payload that preserves successful endpoint reads when one
 * optional endpoint fails.
 */
export interface HealthSnapshot {
  readonly system?: HealthResponse;
  readonly llm?: LLMHealthRead;
  readonly providerSelection?: LLMProviderSelectionRead;
  readonly runtimeRequirements: RuntimeRequirementRead[];
}

/**
 * Provider-selection API surface used by health.
 */
export interface LLMProviderSelectionApiClient {
  llmProviderSelection(): Observable<LLMProviderSelectionRead>;
}

/**
 * Minimal model-download API surface used by the Angular health workflow.
 */
export interface ModelDownloadApiClient {
  startModelDownload(): Observable<ModelDownloadRead>;
  getModelDownload(jobId: string): Observable<ModelDownloadRead>;
  cancelModelDownload(jobId: string): Observable<ModelDownloadRead>;
}

/**
 * Minimal runtime-installation API surface used by the Angular health workflow.
 */
export interface RuntimeInstallationApiClient {
  runtimeRequirements(): Observable<{ items: RuntimeRequirementRead[] }>;
  startRuntimeInstallation(kind: string): Observable<RuntimeInstallationRead>;
  getRuntimeInstallation(jobId: string): Observable<RuntimeInstallationRead>;
  cancelRuntimeInstallation(jobId: string): Observable<RuntimeInstallationRead>;
}

export interface RuntimeActionContext {
  readonly canDownloadModel: () => boolean;
  readonly canInstallRuntime: (kind: RuntimeKind) => boolean;
  readonly configuredModelName: () => string;
  readonly refreshHealthAfterRuntimeChange: () => void;
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
