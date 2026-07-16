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
      providerSelection: this.providerSelectionSummary(state),
      python,
      ollama,
      model,
      ocr,
    };
  }

  private providerSelectionSummary(
    state: ModelHealthViewState,
  ): ModelHealthViewModel['providerSelection'] {
    const selection = state.providerSelection;
    if (selection === null) {
      return null;
    }

    const selectedProvider = this.providerLabel(selection.selected_provider);
    const effectiveProvider = this.providerLabel(selection.effective_provider);
    const fallbackActive =
      Boolean(selection.fallback_reason?.trim()) ||
      selection.selected_provider !== selection.effective_provider ||
      selection.configured_model !== selection.effective_model;
    return {
      preferenceLabel: this.preferenceLabel(selection.preference),
      selectedLabel: `${selectedProvider} / ${selection.configured_model}`,
      effectiveLabel: `${effectiveProvider} / ${selection.effective_model}`,
      selectionReason: selection.selection_reason,
      fallbackReason: selection.fallback_reason ?? null,
      fallbackActive,
    };
  }

  private pythonSection(state: ModelHealthViewState): RuntimeStatusSectionView {
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

  private ollamaSection(state: ModelHealthViewState): RuntimeStatusSectionView {
    return {
      title: this.llmRuntimeLabel(state),
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
      return `${this.llmRuntimeLabel(state)} waiting`;
    }
    if (state.llmRuntimeMissing) {
      return `${this.llmRuntimeLabel(state)} missing`;
    }
    return this.llmRuntimeLabel(state);
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
      return `${this.llmRuntimeLabel(state)} status unavailable.`;
    }
    return state.llmHealth.detail;
  }

  private modelDetail(state: ModelHealthViewState): string {
    if (!state.backendReady) {
      return 'Waiting for Python backend runtime.';
    }
    if (state.llmRuntimeMissing) {
      return `Start or install ${this.llmRuntimeLabel(state)} before using the reasoning model.`;
    }
    if (state.llmHealth === null) {
      return 'Model status unavailable.';
    }
    if (state.modelFallbackActive) {
      if (state.providerSelection?.fallback_reason) {
        return [
          `Effective ${this.providerLabel(state.providerSelection.effective_provider)}`,
          `${state.effectiveModelName}.`,
          `Fallback: ${state.providerSelection.fallback_reason}`,
        ].join(' ');
      }
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
    if (state.ocrHealth?.provider === 'windowsml') {
      return 'WindowsML OCR';
    }
    return 'PaddleOCR';
  }

  private ollamaStatusLabel(state: ModelHealthViewState): string {
    if (!state.backendReady) {
      return 'Waiting';
    }
    if (state.llmRuntimeMissing) {
      return 'Missing';
    }
    if (state.llmHealth === null) {
      return 'Unknown';
    }
    return state.llmHealth.available ? 'Ready' : 'Offline';
  }

  private modelStatusLabel(state: ModelHealthViewState): string {
    if (!state.backendReady || state.llmRuntimeMissing) {
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
    if (state.llmRuntimeMissing) {
      return 'danger';
    }
    return state.llmHealth?.available === false ? 'warn' : 'success';
  }

  private modelSeverity(state: ModelHealthViewState): HealthStatusSeverity {
    if (!state.backendReady || state.llmRuntimeMissing) {
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

  private llmRuntimeLabel(state: ModelHealthViewState): string {
    return this.providerLabel(
      state.providerSelection?.selected_provider ?? state.llmHealth?.provider,
    );
  }

  private providerLabel(providerValue: string | null | undefined): string {
    const provider = providerValue?.trim().toLowerCase();
    if (provider === 'ollama') {
      return 'Ollama';
    }
    if (provider === 'fake') {
      return 'Fake LLM';
    }
    return 'LLM runtime';
  }

  private preferenceLabel(preferenceValue: string): string {
    const preference = preferenceValue.trim().toLowerCase();
    if (preference === 'auto') {
      return 'Auto';
    }
    return this.providerLabel(preferenceValue);
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
