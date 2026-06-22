import { Injectable } from '@angular/core';
import type {
  LLMHealthRead,
  OCRHealthRead,
  RuntimeRequirementRead,
} from '../../exam-prep-api';
import type {
  LLMHealthWithMissingReason,
  RuntimeKind,
} from './contracts/health-runtime.contracts';

const MODEL_MISSING_REASON_CODES = new Set([
  'model_missing',
  'missing_model',
  'ollama_model_missing',
]);
const OCR_RUNTIME_MISSING_REASON_CODES = new Set([
  'paddle_runtime_missing',
  'directml_runtime_missing',
]);

@Injectable({ providedIn: 'root' })
export class RuntimeHealthDerivationService {
  isModelMissing(health: LLMHealthRead | null): boolean {
    if (health === null || health.available !== false) {
      return false;
    }

    const extended = health as LLMHealthWithMissingReason;
    const reason = [
      extended.code,
      extended.error_code,
      extended.reason,
      extended.unavailable_reason,
    ]
      .map((value) => this.normalizedCode(value))
      .find((value) => value.length > 0);

    if (reason !== undefined && MODEL_MISSING_REASON_CODES.has(reason)) {
      return true;
    }

    return /\bmodel\b.*\b(missing|not found)\b/i.test(health.detail);
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
  ): Extract<RuntimeKind, 'paddle_ocr' | 'directml_ocr'> {
    const healthProvider = this.normalizedCode(health?.provider);
    const healthReason = this.unavailableReason(health);
    if (
      healthProvider === 'directml' ||
      healthReason.startsWith('directml_')
    ) {
      return 'directml_ocr';
    }
    if (
      requirements.some(
        (item) =>
          item.kind === 'directml_ocr' &&
          this.normalizedCode(item.unavailable_reason).startsWith('directml_'),
      )
    ) {
      return 'directml_ocr';
    }
    return 'paddle_ocr';
  }

  configuredModelName(
    health: LLMHealthRead | null,
    fallbackModel: string | null | undefined,
  ): string {
    return health?.model ?? fallbackModel ?? 'configured model';
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
}
