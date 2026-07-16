import { Injectable } from '@angular/core';
import type {
  LLMHealthRead,
  OCRHealthRead,
  RuntimeRequirementRead,
} from '../../cert-prep-api';
import type {
  LLMProviderSelectionRead,
  RuntimeKind,
} from './contracts/health-runtime.contracts';

const OCR_RUNTIME_MISSING_REASON_CODES = new Set([
  'paddle_runtime_missing',
  'windowsml_runtime_missing',
]);
const LLM_RUNTIME_MISSING_REASON_CODES = new Set(['ollama_missing']);

@Injectable({ providedIn: 'root' })
export class RuntimeHealthDerivationService {
  isModelMissing(
    health: LLMHealthRead | null,
    requirements: readonly RuntimeRequirementRead[] = [],
  ): boolean {
    return (
      this.modelRequirementMissing(requirements, 'ollama_model') ||
      this.isModelMissingFromHealth(health)
    );
  }

  isOllamaMissing(
    health: LLMHealthRead | null,
    requirements: readonly RuntimeRequirementRead[],
  ): boolean {
    return (
      this.unavailableReason(health) === 'ollama_missing' ||
      this.runtimeUnavailableReason(requirements, 'ollama') === 'ollama_missing'
    );
  }

  isLlmRuntimeMissing(
    health: LLMHealthRead | null,
    requirements: readonly RuntimeRequirementRead[],
    selection: LLMProviderSelectionRead | null = null,
  ): boolean {
    const selectedKind = this.normalizedCode(
      selection?.runtime_requirement_kind,
    );
    if (selectedKind === 'ollama') {
      return this.isOllamaMissing(health, requirements);
    }
    if (LLM_RUNTIME_MISSING_REASON_CODES.has(this.unavailableReason(health))) {
      return true;
    }
    return this.isOllamaMissing(health, requirements);
  }

  llmProviderLabel(
    health: LLMHealthRead | null,
    selection: LLMProviderSelectionRead | null = null,
  ): string {
    return this.providerLabel(selection?.selected_provider ?? health?.provider);
  }

  providerLabel(providerValue: unknown): string {
    const provider = this.normalizedCode(providerValue);
    if (provider === 'ollama') {
      return 'Ollama';
    }
    if (provider === 'fake') {
      return 'Fake LLM';
    }
    return 'LLM provider';
  }

  isOcrRuntimeMissing(
    health: OCRHealthRead | null,
    requirements: readonly RuntimeRequirementRead[],
  ): boolean {
    const kind = this.ocrRuntimeKind(health, requirements);
    return (
      OCR_RUNTIME_MISSING_REASON_CODES.has(this.unavailableReason(health)) ||
      OCR_RUNTIME_MISSING_REASON_CODES.has(
        this.runtimeUnavailableReason(requirements, kind),
      )
    );
  }

  ocrRuntimeKind(
    health: OCRHealthRead | null,
    requirements: readonly RuntimeRequirementRead[],
  ): Extract<RuntimeKind, 'paddle_ocr' | 'windowsml_ocr'> {
    const healthProvider = this.normalizedCode(health?.provider);
    const healthReason = this.unavailableReason(health);
    if (
      healthProvider === 'windowsml' ||
      healthReason.startsWith('windowsml_')
    ) {
      return 'windowsml_ocr';
    }
    if (
      requirements.some(
        (item) =>
          item.kind === 'windowsml_ocr' &&
          this.normalizedCode(item.unavailable_reason).startsWith('windowsml_'),
      )
    ) {
      return 'windowsml_ocr';
    }
    return 'paddle_ocr';
  }

  configuredModelName(
    health: LLMHealthRead | null,
    fallbackModel: string | null | undefined,
    selection: LLMProviderSelectionRead | null = null,
  ): string {
    return (
      selection?.configured_model ??
      health?.configured_model ??
      health?.model ??
      fallbackModel ??
      'configured model'
    );
  }

  effectiveModelName(
    health: LLMHealthRead | null,
    fallbackModel: string | null | undefined,
    selection: LLMProviderSelectionRead | null = null,
  ): string {
    return (
      selection?.effective_model ??
      health?.effective_model ??
      health?.model ??
      fallbackModel ??
      'configured model'
    );
  }

  isConfiguredModelMissing(
    health: LLMHealthRead | null,
    selectionOrRequirements:
      | LLMProviderSelectionRead
      | readonly RuntimeRequirementRead[]
      | null = null,
  ): boolean {
    const requirements = this.isRequirementList(selectionOrRequirements)
      ? selectionOrRequirements
      : [];
    return this.isModelMissing(health, requirements);
  }

  normalizedCode(value: unknown): string {
    return typeof value === 'string'
      ? value
          .trim()
          .toLowerCase()
          .replace(/[\s-]+/g, '_')
      : '';
  }

  private unavailableReason(health: LLMHealthRead | OCRHealthRead | null) {
    return this.normalizedCode(health?.unavailable_reason);
  }

  private runtimeUnavailableReason(
    requirements: readonly RuntimeRequirementRead[],
    kind: RuntimeKind,
  ): string {
    const requirement = requirements.find((item) => item.kind === kind);
    return this.normalizedCode(requirement?.unavailable_reason);
  }

  private isModelMissingFromHealth(health: LLMHealthRead | null): boolean {
    return (
      health?.available === false &&
      this.unavailableReason(health) === 'model_missing'
    );
  }

  private isRequirementList(
    value: LLMProviderSelectionRead | readonly RuntimeRequirementRead[] | null,
  ): value is readonly RuntimeRequirementRead[] {
    return Array.isArray(value);
  }

  private modelRequirementMissing(
    requirements: readonly RuntimeRequirementRead[],
    kind: Extract<RuntimeKind, 'ollama_model'>,
  ): boolean {
    const requirement = requirements.find((item) => item.kind === kind);
    return (
      requirement?.available === false &&
      this.normalizedCode(requirement.unavailable_reason) === 'model_missing'
    );
  }
}
