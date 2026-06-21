import type {
  HealthResponse,
  LLMHealthRead,
  OCRHealthRead,
} from '../../../exam-prep-api';
import type { OcrHealthPhase } from '../../../stores/health/contracts/health-runtime.contracts';

/**
 * PrimeNG tag severities used by the health/runtime status UI.
 */
export type HealthStatusSeverity = 'success' | 'danger' | 'info' | 'warn';

/**
 * Compact status chip rendered in the health toolbar.
 */
export interface RuntimeStatusChipView {
  readonly label: string;
  readonly severity: HealthStatusSeverity;
}

/**
 * Status text and severity for one row in the runtime manager drawer.
 */
export interface RuntimeStatusSectionView {
  readonly title: string;
  readonly statusLabel: string;
  readonly severity: HealthStatusSeverity;
  readonly detail: string;
}

/**
 * Complete presentation model for the runtime toolbar and manager rows.
 */
export interface ModelHealthViewModel {
  readonly chips: readonly RuntimeStatusChipView[];
  readonly python: RuntimeStatusSectionView;
  readonly ollama: RuntimeStatusSectionView;
  readonly model: RuntimeStatusSectionView;
  readonly ocr: RuntimeStatusSectionView;
}

export interface DesktopRuntimeStatusView {
  readonly status: string;
  readonly detail: string;
  readonly running: boolean;
}

/**
 * Raw store state needed to derive labels, details, and status severities
 * without coupling the stores to UI copy.
 */
export interface ModelHealthViewState {
  readonly backendReady: boolean;
  readonly pythonRuntimeMissing: boolean;
  readonly pythonInstallActive: boolean;
  readonly desktopStatus: DesktopRuntimeStatusView;
  readonly desktopInstallDetail: string | null;
  readonly systemHealth: HealthResponse | null;
  readonly llmHealth: LLMHealthRead | null;
  readonly ocrHealth: OCRHealthRead | null;
  readonly ocrPhase: OcrHealthPhase;
  readonly ollamaMissing: boolean;
  readonly modelMissing: boolean;
  readonly ocrRuntimeMissing: boolean;
  readonly configuredModelName: string;
}
