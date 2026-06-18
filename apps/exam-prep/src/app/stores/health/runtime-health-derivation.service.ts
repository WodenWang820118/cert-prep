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
    return (
      this.unavailableReason(health) === 'paddle_runtime_missing' ||
      this.runtimeUnavailableReason(requirements, 'paddle_ocr') ===
        'paddle_runtime_missing'
    );
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
