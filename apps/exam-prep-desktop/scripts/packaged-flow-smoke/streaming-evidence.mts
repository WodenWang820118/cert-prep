import { isRecord, numberField, stringField } from './text-utils.mts';
import type {
  StreamingJobCompletionState,
  StreamingDraftJobSnapshot,
  StreamingQuestionSnapshot,
  WindowsMlNpuPrepassEvidence,
} from './types.mts';

export const FIRST_CHUNK_GATE_MS = 15_000;

const TERMINAL_STREAMING_JOB_STATUSES = new Set([
  'succeeded',
  'failed',
  'skipped_provider_unavailable',
  'skipped_missing_model',
]);

/** Classifies the compact streaming status copy shown during packaged smoke. */
export function classifyStreamingQuestionStatus(
  text: string,
): 'active' | 'ready' | 'blocked' | 'none' {
  if (/[1-9]\d* questions ready/i.test(text)) {
    return 'ready';
  }
  if (
    /Model missing|Reasoning unavailable|Question generation needs attention/i.test(
      text,
    )
  ) {
    return 'blocked';
  }
  if (/Generating \d+\/\d+/i.test(text)) {
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

/** Stores only counts for generated editable questions from qwen responses. */
export function sanitizeQuestionSnapshot(
  payload: unknown,
  elapsedMs: number,
): StreamingQuestionSnapshot {
  const items = responseItems(payload);
  return {
    elapsed_ms: normalizedElapsedMs(elapsedMs),
    source: 'question-drafts',
    item_count: items.length,
    usable_question_count: items.filter(isUsableQuestionPayload).length,
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

/** Records the packaged smoke first-chunk gate without conflating it with wait timing. */
export function firstChunkGateMetrics(
  firstChunkVisibleMs: number | undefined,
  gateMs = FIRST_CHUNK_GATE_MS,
): { first_chunk_gate_ms: number; first_chunk_under_gate: boolean } {
  const normalizedGateMs = normalizedElapsedMs(gateMs);
  return {
    first_chunk_gate_ms: normalizedGateMs,
    first_chunk_under_gate:
      firstChunkVisibleMs !== undefined &&
      normalizedElapsedMs(firstChunkVisibleMs) < normalizedGateMs,
  };
}

/** Parses compact WindowsML NPU prepass evidence from the existing OCR metadata. */
export function parseWindowsmlNpuPrepassEvidence(
  ocrDevice: unknown,
  fallbackReason: unknown,
): WindowsMlNpuPrepassEvidence {
  const device = nullableString(ocrDevice);
  const fallback = nullableString(fallbackReason);
  const vitisaiEvents = fallbackMetric(fallback, 'vitisai_events');
  const cpuEvents = fallbackMetric(fallback, 'cpu_events');
  const success = /\bnpu_prepass=text_density_vitisai\b/.test(fallback ?? '');
  const unavailableReason = unavailableNpuPrepassReason(fallback);
  const deviceIsWindowsml =
    device === 'amd_windowsml' || device?.startsWith('amd_windowsml:') === true;
  const available = deviceIsWindowsml && success && vitisaiEvents > 0;
  return {
    source: 'document_ocr_fallback_reason',
    available,
    attempted: success || unavailableReason !== null,
    ocr_device: device,
    fallback_reason: fallback,
    vitisai_events: vitisaiEvents,
    cpu_events: cpuEvents,
    reason: available
      ? null
      : normalizeNpuPrepassUnavailableReason(unavailableReason) ??
        (deviceIsWindowsml
          ? 'npu_prepass_evidence_missing'
          : 'ocr_device_not_windowsml'),
  };
}

/** Summarizes whether the latest draft-job status histogram is complete. */
export function streamingJobCompletionState(
  statusCounts: Record<string, number>,
): StreamingJobCompletionState {
  let totalCount = 0;
  let terminalCount = 0;
  let succeededCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const [status, count] of Object.entries(statusCounts)) {
    const normalizedCount = Math.max(0, Math.trunc(numberField(count)));
    totalCount += normalizedCount;
    if (TERMINAL_STREAMING_JOB_STATUSES.has(status)) {
      terminalCount += normalizedCount;
    }
    if (status === 'succeeded') {
      succeededCount += normalizedCount;
    } else if (status === 'failed') {
      failedCount += normalizedCount;
    } else if (status.startsWith('skipped_')) {
      skippedCount += normalizedCount;
    }
  }

  const activeCount = totalCount - terminalCount;
  return {
    total_count: totalCount,
    active_count: activeCount,
    terminal_count: terminalCount,
    succeeded_count: succeededCount,
    failed_count: failedCount,
    skipped_count: skippedCount,
    all_terminal: totalCount > 0 && activeCount === 0,
    all_succeeded:
      totalCount > 0 &&
      activeCount === 0 &&
      failedCount === 0 &&
      skippedCount === 0 &&
      succeededCount === totalCount,
  };
}

function responseItems(payload: unknown): unknown[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return [];
  }
  return payload.items;
}

function isUsableQuestionPayload(item: unknown): boolean {
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

function fallbackMetric(fallbackReason: string | null, key: string): number {
  if (!fallbackReason) {
    return 0;
  }
  const pattern = new RegExp(`(?:^|;)\\s*${key}=(\\d+)\\b`);
  const match = fallbackReason.match(pattern);
  return match ? numberField(Number(match[1])) : 0;
}

function unavailableNpuPrepassReason(fallbackReason: string | null): string | null {
  if (!fallbackReason) {
    return null;
  }
  const match = fallbackReason.match(/(?:^|;)\s*npu_prepass_unavailable=([^;]+)/);
  return match ? match[1].trim() || 'npu_prepass_unavailable' : null;
}

function normalizeNpuPrepassUnavailableReason(reason: string | null): string | null {
  if (reason === 'vitisai_events_missing') {
    return 'attempted_not_scheduled';
  }
  return reason;
}

function nullableString(value: unknown): string | null {
  const normalized = stringField(value).trim();
  return normalized.length > 0 ? normalized : null;
}
