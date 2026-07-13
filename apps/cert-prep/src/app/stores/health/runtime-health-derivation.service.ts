import { Injectable } from '@angular/core';
import type {
  LLMHealthRead,
  OCRHealthRead,
  RuntimeRequirementRead,
} from '../../cert-prep-api';
import type { RuntimeKind } from './contracts/health-runtime.contracts';

const OCR_RUNTIME_MISSING_REASON_CODES = new Set([
  'paddle_runtime_missing',
  'windowsml_runtime_missing',
]);
const LLM_RUNTIME_MISSING_REASON_CODES = new Set([
  'fastflowlm_missing',
  'ollama_missing',
]);

@Injectable({ providedIn: 'root' })
export class RuntimeHealthDerivationService {
  isModelMissing(
    health: LLMHealthRead | null,
    requirements: readonly RuntimeRequirementRead[] = [],
  ): boolean {
    const provider = this.normalizedCode(health?.provider);
    const requirementMissing = this.modelRequirementMissing(
      requirements,
      provider === 'fastflowlm' ? 'fastflowlm_model' : 'ollama_model',
    );
    return provider === 'fastflowlm'
      ? requirementMissing
      : requirementMissing || this.isModelMissingFromHealth(health);
  }

  isOllamaMissing(
    health: LLMHealthRead | null,
    requirements: readonly RuntimeRequirementRead[],
  ): boolean {
    return (
      this.unavailableReason(health) === 'ollama_missing' ||
      this.runtimeUnavailableReason(requirements, 'ollama') ===
        'ollama_missing'
    );
  }

  isFastFlowMissing(
    health: LLMHealthRead | null,
    requirements: readonly RuntimeRequirementRead[],
  ): boolean {
    return (
      this.unavailableReason(health) === 'fastflowlm_missing' ||
      this.runtimeUnavailableReason(requirements, 'fastflowlm') ===
        'fastflowlm_missing'
    );
  }

  isFastFlowTermsRequired(
    requirements: readonly RuntimeRequirementRead[],
  ): boolean {
    return (
      this.runtimeUnavailableReason(requirements, 'fastflowlm') ===
        'fastflowlm_terms_required' ||
      this.runtimeUnavailableReason(requirements, 'fastflowlm_model') ===
        'fastflowlm_terms_required'
    );
  }

  isFastFlowInstallationRequired(
    requirements: readonly RuntimeRequirementRead[],
  ): boolean {
    return (
      this.runtimeUnavailableReason(requirements, 'fastflowlm') ===
      'fastflowlm_missing'
    );
  }

  isFastFlowRuntimeAvailable(
    requirements: readonly RuntimeRequirementRead[],
  ): boolean {
    const requirement = requirements.find(
      (item) => item.kind === 'fastflowlm',
    );
    return (
      requirement?.available === true &&
      this.normalizedCode(requirement.unavailable_reason).length === 0
    );
  }

  isFastFlowProvider(health: LLMHealthRead | null): boolean {
    return this.normalizedCode(health?.provider) === 'fastflowlm';
  }

  isLlmRuntimeMissing(
    health: LLMHealthRead | null,
    requirements: readonly RuntimeRequirementRead[],
  ): boolean {
    if (LLM_RUNTIME_MISSING_REASON_CODES.has(this.unavailableReason(health))) {
      return true;
    }
    return (
      this.isFastFlowMissing(health, requirements) ||
      this.isFastFlowTermsRequired(requirements) ||
      this.isOllamaMissing(health, requirements)
    );
  }

  llmProviderLabel(health: LLMHealthRead | null): string {
    const provider = this.normalizedCode(health?.provider);
    if (provider === 'fastflowlm') {
      return 'FastFlowLM';
    }
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
  ): string {
    return (
      health?.configured_model ??
      health?.model ??
      fallbackModel ??
      'configured model'
    );
  }

  effectiveModelName(
    health: LLMHealthRead | null,
    fallbackModel: string | null | undefined,
  ): string {
    return (
      health?.effective_model ??
      health?.model ??
      fallbackModel ??
      'configured model'
    );
  }

  isConfiguredModelMissing(
    health: LLMHealthRead | null,
    requirements: readonly RuntimeRequirementRead[] = [],
  ): boolean {
    return (
      this.isModelMissing(health, requirements) ||
      this.isModelFallbackActive(health)
    );
  }

  isModelFallbackActive(health: LLMHealthRead | null): boolean {
    if (health === null || health.available !== true) {
      return false;
    }

    const configured = this.normalizedModelName(
      health.configured_model ?? health.model,
    );
    const effective = this.normalizedModelName(
      health.effective_model ?? health.model,
    );
    return configured.length > 0 && effective.length > 0 && configured !== effective;
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

  private modelRequirementMissing(
    requirements: readonly RuntimeRequirementRead[],
    kind: Extract<RuntimeKind, 'fastflowlm_model' | 'ollama_model'>,
  ): boolean {
    const requirement = requirements.find((item) => item.kind === kind);
    return (
      requirement?.available === false &&
      this.normalizedCode(requirement.unavailable_reason) === 'model_missing'
    );
  }

  private normalizedModelName(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }
}
