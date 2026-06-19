import { isRecord, numberField, stringField } from './text-utils.mts';
import type {
  StreamingDraftJobSnapshot,
  StreamingQuestionDraftSnapshot,
} from './types.mts';

/** Classifies the compact streaming status copy shown during packaged smoke. */
export function classifyStreamingDraftStatus(
  text: string,
): 'active' | 'ready' | 'blocked' | 'none' {
  if (/[1-9]\d* drafts ready/i.test(text)) {
    return 'ready';
  }
  if (/Model missing|Reasoning unavailable|Drafting needs attention/i.test(text)) {
    return 'blocked';
  }
  if (/Drafting \d+\/\d+/i.test(text)) {
    return 'active';
  }
  return 'none';
}

/** Counts draft-job statuses without retaining draft content. */
export function draftJobStatusCounts(payload: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of responseItems(payload)) {
    const status = isRecord(item) ? stringField(item.status).trim() : '';
    if (status) {
      counts[status] = (counts[status] ?? 0) + 1;
    }
  }
  return counts;
}

/** Stores draft-job evidence without persisting question text, choices, or auth. */
export function sanitizeDraftJobSnapshot(
  payload: unknown,
  elapsedMs: number,
): StreamingDraftJobSnapshot {
  const items = responseItems(payload);
  const statusCounts = draftJobStatusCounts(payload);
  const generatedCount = items.reduce<number>((total, item) => {
    if (!isRecord(item)) {
      return total;
    }
    return total + numberField(item.generated_count);
  }, 0);
  const blocker = streamingDraftBlockerFromStatusCounts(statusCounts);
  return {
    elapsed_ms: normalizedElapsedMs(elapsedMs),
    source: 'draft-jobs',
    item_count: items.length,
    status_counts: statusCounts,
    generated_count: generatedCount,
    ...(blocker ? { blocker } : {}),
  };
}

/** Stores only draft counts and usable-draft counts from qwen draft responses. */
export function sanitizeQuestionDraftSnapshot(
  payload: unknown,
  elapsedMs: number,
): StreamingQuestionDraftSnapshot {
  const items = responseItems(payload);
  return {
    elapsed_ms: normalizedElapsedMs(elapsedMs),
    source: 'question-drafts',
    item_count: items.length,
    usable_count: items.filter(isUsableQuestionDraftPayload).length,
  };
}

/** Merges status-count maps while preserving prior observations. */
export function mergeStatusCounts(
  target: Record<string, number>,
  source: Record<string, number>,
): void {
  for (const [status, count] of Object.entries(source)) {
    target[status] = (target[status] ?? 0) + count;
  }
}

function responseItems(payload: unknown): unknown[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return [];
  }
  return payload.items;
}

function isUsableQuestionDraftPayload(item: unknown): boolean {
  if (!isRecord(item)) {
    return false;
  }
  const question = stringField(item.question).trim();
  const choices = Array.isArray(item.choices)
    ? item.choices.filter(
        (choice) => typeof choice === 'string' && choice.trim().length > 0,
      )
    : [];
  return question.length > 0 && choices.length >= 2;
}

function streamingDraftBlockerFromStatusCounts(
  statusCounts: Record<string, number>,
): string | undefined {
  if (statusCounts.skipped_missing_model) {
    return 'skipped_missing_model';
  }
  if (statusCounts.skipped_provider_unavailable) {
    return 'skipped_provider_unavailable';
  }
  if (statusCounts.failed) {
    return 'failed';
  }
  return undefined;
}

function normalizedElapsedMs(value: number): number {
  return Math.max(0, Math.round(value));
}
