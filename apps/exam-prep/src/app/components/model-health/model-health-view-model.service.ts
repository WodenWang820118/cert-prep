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
      title: this.ocrTitle(state),
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
    if (state.modelMissing) {
      return 'Reasoning model missing';
    }
    return state.modelFallbackActive
      ? `Reasoning model: ${state.effectiveModelName}`
      : `Reasoning model: ${state.configuredModelName}`;
  }

  private ocrChipLabel(state: ModelHealthViewState): string {
    if (!state.backendReady) {
      return 'OCR waiting';
    }

    if (state.ocrPhase === 'checking') {
      return 'OCR checking';
    }

    if (state.ocrPhase === 'warming') {
      return 'OCR warming';
    }

    if (state.ocrPhase === 'stale') {
      return 'OCR stale';
    }

    if (state.ocrPhase === 'waiting') {
      return 'OCR waiting';
    }

    if (state.ocrPhase === 'failed') {
      return state.ocrRuntimeMissing ? 'OCR missing' : 'OCR failed';
    }

    const health = state.ocrHealth;
    if (health === null) {
      return 'OCR waiting';
    }
    const device = health.selected_device ?? health.engine;
    return `${health.provider} / ${device}`;
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
    if (state.modelFallbackActive) {
      return [
        `Ready via fallback ${state.effectiveModelName};`,
        `primary ${state.configuredModelName} is not installed.`,
      ].join(' ');
    }
    return state.modelMissing
      ? `${state.llmHealth.model} is missing locally.`
      : state.llmHealth.detail;
  }

  private ocrDetail(state: ModelHealthViewState): string {
    const title = this.ocrTitle(state);
    if (!state.backendReady) {
      return 'Waiting for Python backend runtime.';
    }
    if (state.ocrPhase === 'checking') {
      return `Checking ${title} runtime health.`;
    }
    if (state.ocrPhase === 'warming') {
      return `${title} is warming up.`;
    }
    if (state.ocrPhase === 'stale') {
      return `Refreshing cached ${title} status.`;
    }
    if (state.ocrPhase === 'waiting') {
      return `Waiting for ${title} status.`;
    }
    if (state.ocrHealth === null) {
      return state.ocrRuntimeMissing
        ? `${title} runtime is not installed.`
        : `${title} health check failed.`;
    }
    return state.ocrHealth.fallback_reason || state.ocrHealth.detail;
  }

  private ocrTitle(state: ModelHealthViewState): string {
    return state.ocrHealth?.provider === 'directml'
      ? 'AMD DirectML OCR'
      : 'PaddleOCR';
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
    if (state.modelFallbackActive) {
      return 'Ready via fallback';
    }
    return state.llmHealth?.available ? 'Ready' : 'Offline';
  }

  private ocrStatusLabel(state: ModelHealthViewState): string {
    if (!state.backendReady) {
      return 'Waiting';
    }
    if (state.ocrPhase === 'checking') {
      return 'Checking';
    }
    if (state.ocrPhase === 'warming') {
      return 'Warming';
    }
    if (state.ocrPhase === 'stale') {
      return 'Stale';
    }
    if (state.ocrPhase === 'waiting') {
      return 'Waiting';
    }
    if (state.ocrRuntimeMissing) {
      return 'Missing';
    }
    return state.ocrPhase === 'ready' ? 'Ready' : 'Offline';
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
      : state.modelFallbackActive
        ? 'warn'
      : state.llmHealth?.available
        ? 'success'
        : 'warn';
  }

  private ocrSeverity(state: ModelHealthViewState): HealthStatusSeverity {
    if (!state.backendReady) {
      return 'info';
    }
    if (['waiting', 'checking', 'warming', 'stale'].includes(state.ocrPhase)) {
      return 'info';
    }
    return state.ocrRuntimeMissing
      ? 'danger'
      : state.ocrPhase === 'ready'
        ? 'success'
        : 'warn';
  }
}
