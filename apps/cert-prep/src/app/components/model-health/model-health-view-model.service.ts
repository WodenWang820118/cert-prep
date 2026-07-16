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
    return {
      preferenceLabel: this.preferenceLabel(selection.preference),
      selectedLabel: `${selectedProvider} / ${selection.configured_model}`,
      effectiveLabel: `${effectiveProvider} / ${selection.effective_model}`,
      selectionReason: selection.selection_reason,
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
    if (this.cpuExecutionActive(state)) {
      return `Reasoning model: ${state.effectiveModelName} · 使用 CPU 中`;
    }
    return `Reasoning model: ${state.configuredModelName}`;
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
    if (this.ocrCpuFallbackActive(state)) {
      return 'WindowsML OCR · 使用 CPU 中';
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
    if (this.cpuExecutionActive(state)) {
      return (
        state.llmHealth.execution_warning?.trim() || state.llmHealth.detail
      );
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
    return this.ocrCpuFallbackActive(state)
      ? state.ocrHealth.fallback_reason || state.ocrHealth.detail
      : state.ocrHealth.detail;
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
    if (this.cpuExecutionActive(state)) {
      return '使用 CPU 中';
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
    if (this.ocrCpuFallbackActive(state)) {
      return '使用 CPU 中';
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
      : this.cpuExecutionActive(state)
        ? 'warn'
        : state.llmHealth?.available
          ? 'success'
          : 'warn';
  }

  private cpuExecutionActive(state: ModelHealthViewState): boolean {
    return (
      state.llmHealth?.available === true &&
      state.llmHealth.execution_mode === 'cpu'
    );
  }

  private ocrCpuFallbackActive(state: ModelHealthViewState): boolean {
    return (
      state.ocrHealth?.available === true &&
      state.ocrHealth.provider === 'windowsml' &&
      state.ocrHealth.selected_device === 'cpu' &&
      Boolean(state.ocrHealth.fallback_reason?.trim())
    );
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
      : this.ocrCpuFallbackActive(state)
        ? 'warn'
        : state.ocrPhase === 'ready'
          ? 'success'
          : 'warn';
  }
}
