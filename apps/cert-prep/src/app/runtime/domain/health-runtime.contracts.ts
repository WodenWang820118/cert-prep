import type {
  HealthResponse,
  LLMHealthRead,
  LLMInstallationRead,
  LLMRequirementRead,
  LLMRequirementKind,
} from '../../core/domain';
import type { LLMProviderSelectionRead as GeneratedLLMProviderSelectionRead } from '../../core/domain';
import type { Observable } from 'rxjs';
import type {
  LLMInstallationEvent,
} from '../../core/domain';

/**
 * Runtime job lifecycle normalized for UI state and event-stream decisions.
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
  readonly llmRequirements: LLMRequirementRead[];
}

/**
 * Provider-selection API surface used by health.
 */
export interface LLMProviderSelectionApiClient {
  llmProviderSelection(): Observable<LLMProviderSelectionRead>;
}

/**
 * Minimal LLM installation API surface used by the Angular health workflow.
 */
export interface LLMInstallationApiClient {
  llmRequirements(): Observable<{ items: LLMRequirementRead[] }>;
  startLlmInstallation(kind: LLMRequirementKind): Observable<LLMInstallationRead>;
  getLlmInstallation(jobId: string): Observable<LLMInstallationRead>;
  cancelLlmInstallation(jobId: string): Observable<LLMInstallationRead>;
  streamLlmInstallation(jobId: string): Observable<LLMInstallationEvent>;
}

export interface LLMInstallationActionContext {
  readonly canDownloadModel: () => boolean;
  readonly canInstallLLMEngine: (kind: LLMRequirementKind) => boolean;
  readonly configuredModelName: () => string;
  readonly refreshHealthAfterLLMInstallation: () => void;
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
 * View model for one LLM installation job.
 */
export interface LLMInstallationView {
  readonly jobId: string | null;
  readonly kind: LLMRequirementKind;
  readonly label: string;
  readonly phase: DownloadPhase;
  readonly status: string;
  readonly progress: number | null;
  readonly message: string;
  readonly error: string | null;
  readonly cancellable: boolean;
}

/** Canonical runtime job payload narrowed defensively at the UI boundary. */
export type LLMJobRecord = Record<string, unknown>;

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
export interface LLMInstallationViewContext {
  readonly currentJobId: string | null;
}
