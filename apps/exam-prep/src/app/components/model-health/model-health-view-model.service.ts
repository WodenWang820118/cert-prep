import { Injectable } from '@angular/core';
import type {
  HealthStatusSeverity,
  ModelHealthViewModel,
  ModelHealthViewState,
  RuntimeStatusSectionView,
} from './contracts/model-health.contracts';

@Injectable({ providedIn: 'root' })
export class ModelHealthViewModelService {
  create(state: ModelHealthViewState): ModelHealthViewModel {
    const python = this.pythonSection(state);
    const ollama = this.ollamaSection(state);
    const model = this.modelSection(state);
    const ocr = this.ocrSection(state);

    return {
      chips: [
        { label: this.pythonChipLabel(state), severity: python.severity },
        { label: this.ollamaChipLabel(state), severity: ollama.severity },
        { label: this.modelChipLabel(state), severity: model.severity },
        { label: this.ocrChipLabel(state), severity: ocr.severity },
      ],
      python,
      ollama,
      model,
      ocr,
    };
  }

  private pythonSection(
    state: ModelHealthViewState,
  ): RuntimeStatusSectionView {
    return {
      title: 'Python backend',
      statusLabel:
        state.backendReady && state.systemHealth !== null
          ? 'Ready'
          : state.desktopStatus.status,
      severity: this.pythonSeverity(state),
      detail: this.pythonDetail(state),
    };
  }

  private ollamaSection(
    state: ModelHealthViewState,
  ): RuntimeStatusSectionView {
    return {
      title: 'Ollama',
      statusLabel: this.ollamaStatusLabel(state),
      severity: this.ollamaSeverity(state),
      detail: this.ollamaDetail(state),
    };
  }

  private modelSection(state: ModelHealthViewState): RuntimeStatusSectionView {
    return {
      title: 'Reasoning model',
      statusLabel: this.modelStatusLabel(state),
      severity: this.modelSeverity(state),
      detail: this.modelDetail(state),
    };
  }

  private ocrSection(state: ModelHealthViewState): RuntimeStatusSectionView {
    return {
      title: 'PaddleOCR',
      statusLabel: this.ocrStatusLabel(state),
      severity: this.ocrSeverity(state),
      detail: this.ocrDetail(state),
    };
  }

  private pythonChipLabel(state: ModelHealthViewState): string {
    if (state.backendReady && state.systemHealth !== null) {
      return `Python ${state.systemHealth.python_version}`;
    }

    return state.pythonRuntimeMissing
      ? 'Python missing'
      : `Python ${state.desktopStatus.status}`;
  }

  private ollamaChipLabel(state: ModelHealthViewState): string {
    if (!state.backendReady) {
      return 'Ollama waiting';
    }
    if (state.ollamaMissing) {
      return 'Ollama missing';
    }
    return state.llmHealth?.provider ?? 'Ollama unknown';
  }

  private modelChipLabel(state: ModelHealthViewState): string {
    return state.modelMissing
      ? 'Reasoning model missing'
      : `Reasoning model: ${state.configuredModelName}`;
  }

  private ocrChipLabel(state: ModelHealthViewState): string {
    if (!state.backendReady) {
      return 'OCR waiting';
    }

    if (state.ocrHealthLoading) {
      return 'OCR checking';
    }

    if (state.ocrHealth === null) {
      return 'OCR unknown';
    }

    const device = state.ocrHealth.selected_device ?? state.ocrHealth.engine;
    return `${state.ocrHealth.provider} / ${device}`;
  }

  private pythonDetail(state: ModelHealthViewState): string {
    if (state.backendReady && state.systemHealth !== null) {
      return `Python ${state.systemHealth.python_version} / ${state.systemHealth.runtime_mode}`;
    }

    return state.desktopInstallDetail ?? state.desktopStatus.detail;
  }

  private ollamaDetail(state: ModelHealthViewState): string {
    if (!state.backendReady) {
      return 'Waiting for Python backend runtime.';
    }
    if (state.llmHealth === null) {
      return 'Ollama status unavailable.';
    }
    return state.ollamaMissing
      ? 'Ollama is not installed.'
      : state.llmHealth.detail;
  }

  private modelDetail(state: ModelHealthViewState): string {
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

  private ocrDetail(state: ModelHealthViewState): string {
    if (!state.backendReady) {
      return 'Waiting for Python backend runtime.';
    }
    if (state.ocrHealthLoading) {
      return 'PaddleOCR is warming up.';
    }
    if (state.ocrHealth === null) {
      return 'PaddleOCR status unavailable.';
    }
    return state.ocrHealth.fallback_reason || state.ocrHealth.detail;
  }

  private ollamaStatusLabel(state: ModelHealthViewState): string {
    if (!state.backendReady) {
      return 'Waiting';
    }
    if (state.ollamaMissing) {
      return 'Missing';
    }
    return state.llmHealth === null ? 'Unknown' : 'Ready';
  }

  private modelStatusLabel(state: ModelHealthViewState): string {
    if (!state.backendReady || state.ollamaMissing) {
      return 'Waiting';
    }
    if (state.modelMissing) {
      return 'Missing';
    }
    return state.llmHealth?.available ? 'Ready' : 'Offline';
  }

  private ocrStatusLabel(state: ModelHealthViewState): string {
    if (!state.backendReady) {
      return 'Waiting';
    }
    if (state.ocrHealthLoading) {
      return 'Checking';
    }
    if (state.ocrRuntimeMissing) {
      return 'Missing';
    }
    return state.ocrHealth?.available ? 'Ready' : 'Offline';
  }

  private pythonSeverity(state: ModelHealthViewState): HealthStatusSeverity {
    if (state.backendReady) {
      return 'success';
    }
    if (state.pythonInstallActive) {
      return 'warn';
    }
    return state.pythonRuntimeMissing ? 'danger' : 'info';
  }

  private ollamaSeverity(state: ModelHealthViewState): HealthStatusSeverity {
    if (!state.backendReady) {
      return 'info';
    }
    return state.ollamaMissing ? 'danger' : 'success';
  }

  private modelSeverity(state: ModelHealthViewState): HealthStatusSeverity {
    if (!state.backendReady || state.ollamaMissing) {
      return 'info';
    }
    return state.modelMissing
      ? 'danger'
      : state.llmHealth?.available
        ? 'success'
        : 'warn';
  }

  private ocrSeverity(state: ModelHealthViewState): HealthStatusSeverity {
    if (!state.backendReady) {
      return 'info';
    }
    if (state.ocrHealthLoading) {
      return 'info';
    }
    return state.ocrRuntimeMissing
      ? 'danger'
      : state.ocrHealth?.available
        ? 'success'
        : 'warn';
  }
}
