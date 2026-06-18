import type {
  HealthResponse,
  LLMHealthRead,
  OCRHealthRead,
} from '../exam-prep-api';

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

interface DesktopRuntimeStatus {
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
  readonly desktopStatus: DesktopRuntimeStatus;
  readonly desktopInstallDetail: string | null;
  readonly systemHealth: HealthResponse | null;
  readonly llmHealth: LLMHealthRead | null;
  readonly ocrHealth: OCRHealthRead | null;
  readonly ollamaMissing: boolean;
  readonly modelMissing: boolean;
  readonly ocrRuntimeMissing: boolean;
  readonly configuredModelName: string;
}

export function modelHealthViewModel(
  state: ModelHealthViewState,
): ModelHealthViewModel {
  const python = pythonSection(state);
  const ollama = ollamaSection(state);
  const model = modelSection(state);
  const ocr = ocrSection(state);

  return {
    chips: [
      { label: pythonChipLabel(state), severity: python.severity },
      { label: ollamaChipLabel(state), severity: ollama.severity },
      { label: modelChipLabel(state), severity: model.severity },
      { label: ocrChipLabel(state), severity: ocr.severity },
    ],
    python,
    ollama,
    model,
    ocr,
  };
}

function pythonSection(state: ModelHealthViewState): RuntimeStatusSectionView {
  return {
    title: 'Python backend',
    statusLabel:
      state.backendReady && state.systemHealth !== null
        ? 'Ready'
        : state.desktopStatus.status,
    severity: pythonSeverity(state),
    detail: pythonDetail(state),
  };
}

function ollamaSection(state: ModelHealthViewState): RuntimeStatusSectionView {
  return {
    title: 'Ollama',
    statusLabel: ollamaStatusLabel(state),
    severity: ollamaSeverity(state),
    detail: ollamaDetail(state),
  };
}

function modelSection(state: ModelHealthViewState): RuntimeStatusSectionView {
  return {
    title: 'Reasoning model',
    statusLabel: modelStatusLabel(state),
    severity: modelSeverity(state),
    detail: modelDetail(state),
  };
}

function ocrSection(state: ModelHealthViewState): RuntimeStatusSectionView {
  return {
    title: 'PaddleOCR',
    statusLabel: ocrStatusLabel(state),
    severity: ocrSeverity(state),
    detail: ocrDetail(state),
  };
}

function pythonChipLabel(state: ModelHealthViewState): string {
  if (state.backendReady && state.systemHealth !== null) {
    return `Python ${state.systemHealth.python_version}`;
  }

  return state.pythonRuntimeMissing
    ? 'Python missing'
    : `Python ${state.desktopStatus.status}`;
}

function ollamaChipLabel(state: ModelHealthViewState): string {
  if (!state.backendReady) {
    return 'Ollama waiting';
  }
  if (state.ollamaMissing) {
    return 'Ollama missing';
  }
  return state.llmHealth?.provider ?? 'Ollama unknown';
}

function modelChipLabel(state: ModelHealthViewState): string {
  return state.modelMissing
    ? 'Reasoning model missing'
    : `Reasoning model: ${state.configuredModelName}`;
}

function ocrChipLabel(state: ModelHealthViewState): string {
  if (!state.backendReady) {
    return 'OCR waiting';
  }

  if (state.ocrHealth === null) {
    return 'OCR unknown';
  }

  const device = state.ocrHealth.selected_device ?? state.ocrHealth.engine;
  return `${state.ocrHealth.provider} / ${device}`;
}

function pythonDetail(state: ModelHealthViewState): string {
  if (state.backendReady && state.systemHealth !== null) {
    return `Python ${state.systemHealth.python_version} / ${state.systemHealth.runtime_mode}`;
  }

  return state.desktopInstallDetail ?? state.desktopStatus.detail;
}

function ollamaDetail(state: ModelHealthViewState): string {
  if (!state.backendReady) {
    return 'Waiting for Python backend runtime.';
  }
  if (state.llmHealth === null) {
    return 'Ollama status unavailable.';
  }
  return state.ollamaMissing ? 'Ollama is not installed.' : state.llmHealth.detail;
}

function modelDetail(state: ModelHealthViewState): string {
  if (!state.backendReady) {
    return 'Waiting for Python backend runtime.';
  }
  if (state.ollamaMissing) {
    return 'Install Ollama before downloading the reasoning model.';
  }
  if (state.llmHealth === null) {
    return 'Model status unavailable.';
  }
  return state.modelMissing
    ? `${state.llmHealth.model} is missing locally.`
    : state.llmHealth.detail;
}

function ocrDetail(state: ModelHealthViewState): string {
  if (!state.backendReady) {
    return 'Waiting for Python backend runtime.';
  }
  if (state.ocrHealth === null) {
    return 'PaddleOCR status unavailable.';
  }
  return state.ocrHealth.fallback_reason || state.ocrHealth.detail;
}

function ollamaStatusLabel(state: ModelHealthViewState): string {
  if (!state.backendReady) {
    return 'Waiting';
  }
  if (state.ollamaMissing) {
    return 'Missing';
  }
  return state.llmHealth === null ? 'Unknown' : 'Ready';
}

function modelStatusLabel(state: ModelHealthViewState): string {
  if (!state.backendReady || state.ollamaMissing) {
    return 'Waiting';
  }
  if (state.modelMissing) {
    return 'Missing';
  }
  return state.llmHealth?.available ? 'Ready' : 'Offline';
}

function ocrStatusLabel(state: ModelHealthViewState): string {
  if (!state.backendReady) {
    return 'Waiting';
  }
  if (state.ocrRuntimeMissing) {
    return 'Missing';
  }
  return state.ocrHealth?.available ? 'Ready' : 'Offline';
}

function pythonSeverity(state: ModelHealthViewState): HealthStatusSeverity {
  if (state.backendReady) {
    return 'success';
  }
  if (state.pythonInstallActive) {
    return 'warn';
  }
  return state.pythonRuntimeMissing ? 'danger' : 'info';
}

function ollamaSeverity(state: ModelHealthViewState): HealthStatusSeverity {
  if (!state.backendReady) {
    return 'info';
  }
  return state.ollamaMissing ? 'danger' : 'success';
}

function modelSeverity(state: ModelHealthViewState): HealthStatusSeverity {
  if (!state.backendReady || state.ollamaMissing) {
    return 'info';
  }
  return state.modelMissing
    ? 'danger'
    : state.llmHealth?.available
      ? 'success'
      : 'warn';
}

function ocrSeverity(state: ModelHealthViewState): HealthStatusSeverity {
  if (!state.backendReady) {
    return 'info';
  }
  return state.ocrRuntimeMissing
    ? 'danger'
    : state.ocrHealth?.available
      ? 'success'
      : 'warn';
}
