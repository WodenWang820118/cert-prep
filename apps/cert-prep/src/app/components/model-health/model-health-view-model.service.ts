import { Injectable } from '@angular/core';
import type {
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
    return {
      chips: [
        { label: this.pythonChipLabel(state), severity: python.severity },
        { label: this.ollamaChipLabel(state), severity: ollama.severity },
        { label: this.modelChipLabel(state), severity: model.severity },
      ],
      providerSelection: this.providerSelectionSummary(state),
      python,
      ollama,
      model,
    };
  }

  private providerSelectionSummary(state: ModelHealthViewState): ModelHealthViewModel['providerSelection'] {
    const selection = state.providerSelection;
    if (selection === null) return null;
    return {
      preferenceLabel: this.providerLabel(selection.preference),
      selectedLabel: `${this.providerLabel(selection.selected_provider)} / ${selection.configured_model}`,
      effectiveLabel: `${this.providerLabel(selection.effective_provider)} / ${selection.effective_model}`,
      selectionReason: selection.selection_reason,
    };
  }

  private pythonSection(state: ModelHealthViewState): RuntimeStatusSectionView {
    return {
      title: 'Python backend',
      statusLabel: state.backendReady && state.systemHealth !== null ? 'Ready' : state.desktopStatus.status,
      severity: state.backendReady ? 'success' : state.pythonRuntimeMissing ? 'danger' : state.pythonInstallActive ? 'warn' : 'info',
      detail: state.backendReady && state.systemHealth !== null
        ? `Python ${state.systemHealth.python_version} / ${state.systemHealth.runtime_mode}`
        : state.desktopInstallDetail ?? state.desktopStatus.detail,
    };
  }

  private ollamaSection(state: ModelHealthViewState): RuntimeStatusSectionView {
    const title = this.providerLabel(state.providerSelection?.selected_provider ?? state.llmHealth?.provider);
    return {
      title,
      statusLabel: !state.backendReady ? 'Waiting' : state.llmRuntimeMissing ? 'Missing' : state.llmHealth === null ? 'Unknown' : state.llmHealth.available ? 'Ready' : 'Offline',
      severity: !state.backendReady ? 'info' : state.llmRuntimeMissing ? 'danger' : state.llmHealth?.available === false ? 'warn' : 'success',
      detail: !state.backendReady ? 'Waiting for Python backend runtime.' : state.llmHealth?.detail ?? `${title} status unavailable.`,
    };
  }

  private modelSection(state: ModelHealthViewState): RuntimeStatusSectionView {
    const cpu = state.llmHealth?.available === true && state.llmHealth.execution_mode === 'cpu';
    return {
      title: 'Reasoning model',
      statusLabel: !state.backendReady || state.llmRuntimeMissing ? 'Waiting' : state.modelMissing ? 'Missing' : cpu ? 'CPU' : state.llmHealth?.available ? 'Ready' : 'Offline',
      severity: !state.backendReady || state.llmRuntimeMissing ? 'info' : state.modelMissing ? 'danger' : cpu ? 'warn' : state.llmHealth?.available ? 'success' : 'warn',
      detail: !state.backendReady
        ? 'Waiting for Python backend runtime.'
        : state.llmRuntimeMissing
          ? `Start or install ${this.providerLabel(state.providerSelection?.selected_provider ?? state.llmHealth?.provider)} before using the reasoning model.`
          : state.llmHealth?.execution_warning?.trim() || state.llmHealth?.detail || `${state.configuredModelName} status unavailable.`,
    };
  }

  private pythonChipLabel(state: ModelHealthViewState): string {
    return state.backendReady && state.systemHealth !== null
      ? `Python ${state.systemHealth.python_version}`
      : state.pythonRuntimeMissing ? 'Python missing' : `Python ${state.desktopStatus.status}`;
  }

  private ollamaChipLabel(state: ModelHealthViewState): string {
    const label = this.providerLabel(state.providerSelection?.selected_provider ?? state.llmHealth?.provider);
    return !state.backendReady ? `${label} waiting` : state.llmRuntimeMissing ? `${label} missing` : label;
  }

  private modelChipLabel(state: ModelHealthViewState): string {
    return state.modelMissing ? 'Reasoning model missing' : `Reasoning model: ${state.configuredModelName}`;
  }

  private providerLabel(value: string | null | undefined): string {
    const provider = value?.trim().toLowerCase();
    return provider === 'ollama' ? 'Ollama' : provider === 'fake' ? 'Fake LLM' : 'LLM runtime';
  }
}
