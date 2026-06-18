import type {
  LLMHealthRead,
  OCRHealthRead,
  RuntimeRequirementRead,
} from '../exam-prep-api';
import type { RuntimeKind } from './health-runtime.models';

const MODEL_MISSING_REASON_CODES = new Set([
  'model_missing',
  'missing_model',
  'ollama_model_missing',
]);

type LLMHealthWithMissingReason = LLMHealthRead &
  Partial<{
    code: string;
    error_code: string;
    reason: string;
    unavailable_reason: string;
  }>;

export function isModelMissing(health: LLMHealthRead | null): boolean {
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
    .map((value) => normalizedCode(value))
    .find((value) => value.length > 0);

  if (reason !== undefined && MODEL_MISSING_REASON_CODES.has(reason)) {
    return true;
  }

  return /\bmodel\b.*\b(missing|not found)\b/i.test(health.detail);
}

export function isOllamaMissing(
  health: LLMHealthRead | null,
  requirements: readonly RuntimeRequirementRead[],
): boolean {
  return (
    unavailableReason(health) === 'ollama_missing' ||
    runtimeUnavailableReason(requirements, 'ollama') === 'ollama_missing'
  );
}

export function isOcrRuntimeMissing(
  health: OCRHealthRead | null,
  requirements: readonly RuntimeRequirementRead[],
): boolean {
  return (
    unavailableReason(health) === 'paddle_runtime_missing' ||
    runtimeUnavailableReason(requirements, 'paddle_ocr') ===
      'paddle_runtime_missing'
  );
}

export function configuredModelName(
  health: LLMHealthRead | null,
  fallbackModel: string | null | undefined,
): string {
  return health?.model ?? fallbackModel ?? 'configured model';
}

export function normalizedCode(value: unknown): string {
  return typeof value === 'string'
    ? value
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_')
    : '';
}

function unavailableReason(
  health: LLMHealthRead | OCRHealthRead | null,
): string {
  return normalizedCode(health?.unavailable_reason);
}

function runtimeUnavailableReason(
  requirements: readonly RuntimeRequirementRead[],
  kind: RuntimeKind,
): string {
  const requirement = requirements.find((item) => item.kind === kind);
  return normalizedCode(requirement?.unavailable_reason);
}
