import { isRecord, numberField, stringField } from './text-utils.mts';
import type {
  QuestionJobAttribution,
  QuestionJobCompletionState,
  QuestionJobSnapshot,
  QuestionSnapshot,
} from './types.mts';

export const FIRST_CHUNK_GATE_MS = 15_000;

interface WholeSourceScope {
  projectId: string;
  sourceId: string;
}

const TERMINAL_QUESTION_JOB_STATUSES = new Set([
  'succeeded',
  'failed',
  'skipped_provider_unavailable',
  'skipped_missing_model',
]);

/** Classifies the compact question generation status copy shown during packaged smoke. */
export function classifyQuestionGenerationStatus(
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

/** Counts question-job statuses without retaining question content. */
export function questionJobStatusCounts(payload: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of responseItems(payload)) {
    const status = isRecord(item) ? stringField(item.status).trim() : '';
    if (status) {
      counts[status] = (counts[status] ?? 0) + 1;
    }
  }
  return counts;
}

/** Stores question-job evidence without persisting question text, choices, or auth. */
export function sanitizeQuestionJobSnapshot(
  payload: unknown,
  elapsedMs: number,
): QuestionJobSnapshot {
  const items = responseItems(payload);
  const statusCounts = questionJobStatusCounts(payload);
  const jobs = items.map(sanitizeQuestionJobAttribution);
  const generatedCount = jobs.reduce<number>(
    (total, job) =>
      job.status === 'succeeded' && job.generated_count > 0
        ? total + job.generated_count
        : total,
    0,
  );
  const blocker = questionJobBlockerFromStatusCounts(statusCounts);
  return {
    elapsed_ms: normalizedElapsedMs(elapsedMs),
    source: 'question-jobs',
    item_count: items.length,
    status_counts: statusCounts,
    generated_count: generatedCount,
    jobs,
    ...(blocker ? { blocker } : {}),
  };
}

function sanitizeQuestionJobAttribution(
  item: unknown,
): QuestionJobAttribution {
  if (!isRecord(item)) {
    return incompleteQuestionJobAttribution();
  }

  const id = nullableTrimmedString(item.id);
  const status = nullableTrimmedString(item.status);
  const configuredProvider = nullableTrimmedString(item.provider);
  const configuredModel = nullableTrimmedString(item.model);
  const effectiveProvider = nullableTrimmedString(item.effective_provider);
  const effectiveModel = nullableTrimmedString(item.effective_model);
  const rawGeneratedCount = item.generated_count;
  const generatedCountValid =
    typeof rawGeneratedCount === 'number' &&
    Number.isFinite(rawGeneratedCount) &&
    Number.isInteger(rawGeneratedCount) &&
    rawGeneratedCount >= 0;
  const generatedCount = generatedCountValid
    ? Math.trunc(rawGeneratedCount)
    : 0;
  const fallbackFieldPresent = Object.hasOwn(item, 'fallback_reason');
  const rawFallbackReason = item.fallback_reason;
  const fallbackFieldValid =
    fallbackFieldPresent &&
    (rawFallbackReason === null ||
      (typeof rawFallbackReason === 'string' &&
        rawFallbackReason.trim().length > 0));
  const fallbackReason =
    typeof rawFallbackReason === 'string' ? rawFallbackReason.trim() : null;

  return {
    id,
    status,
    generated_count: generatedCount,
    configured_provider: configuredProvider,
    configured_model: configuredModel,
    effective_provider: effectiveProvider,
    effective_model: effectiveModel,
    fallback_reason: fallbackReason,
    attribution_complete:
      id !== null &&
      status !== null &&
      generatedCountValid &&
      configuredProvider !== null &&
      configuredModel !== null &&
      effectiveProvider !== null &&
      effectiveModel !== null &&
      fallbackFieldValid,
  };
}

function incompleteQuestionJobAttribution(): QuestionJobAttribution {
  return {
    id: null,
    status: null,
    generated_count: 0,
    configured_provider: null,
    configured_model: null,
    effective_provider: null,
    effective_model: null,
    fallback_reason: null,
    attribution_complete: false,
  };
}

function nullableTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function practiceReadyQuestion(question: Record<string, unknown>): boolean {
  const prompt = nullableTrimmedString(question.question);
  const answer = nullableTrimmedString(question.answer);
  const rationale = nullableTrimmedString(question.rationale);
  const sourceExcerpt = nullableTrimmedString(question.source_excerpt);
  const citationPage = positiveInteger(question.citation_page);
  if (
    !prompt ||
    !answer ||
    !rationale ||
    (!sourceExcerpt && citationPage === null) ||
    !Array.isArray(question.choices)
  ) {
    return false;
  }
  const choices = question.choices.map(nullableTrimmedString);
  return (
    choices.length >= 2 &&
    choices.every((choice) => choice !== null) &&
    new Set(choices).size === choices.length &&
    choices.includes(answer)
  );
}

/** Stores only counts for generated editable questions from qwen responses. */
export function sanitizeQuestionSnapshot(
  payload: unknown,
  elapsedMs: number,
): QuestionSnapshot {
  const items = responseItems(payload);
  return {
    elapsed_ms: normalizedElapsedMs(elapsedMs),
    source: 'questions',
    item_count: items.length,
    usable_question_count: items.filter(isUsableQuestionPayload).length,
  };
}

/** Returns the actual Whole source size only when request and response prove one source scope. */
export function wholeSourceQuestionCountFromSession(
  requestPayload: unknown,
  responsePayload: unknown,
  expected: WholeSourceScope,
): number | null {
  if (!isRecord(requestPayload) || !isRecord(responsePayload)) {
    return null;
  }
  const requestedCount = positiveInteger(requestPayload.question_count);
  const responseCount = positiveInteger(responsePayload.question_count);
  const questionIds = Array.isArray(responsePayload.question_ids)
    ? responsePayload.question_ids
    : [];
  const questions = Array.isArray(responsePayload.questions)
    ? responsePayload.questions
    : [];
  if (
    requestPayload.mode !== 'full_source' ||
    requestPayload.source_id !== expected.sourceId ||
    responsePayload.mode !== 'full_source' ||
    responsePayload.project_id !== expected.projectId ||
    responsePayload.source_id !== expected.sourceId ||
    responsePayload.status !== 'active' ||
    !nullableTrimmedString(responsePayload.id) ||
    requestedCount === null ||
    responseCount === null ||
    requestedCount !== responseCount ||
    responseCount !== questionIds.length ||
    responseCount !== questions.length
  ) {
    return null;
  }

  const normalizedIds = questionIds.map(nullableTrimmedString);
  if (
    normalizedIds.some((id) => id === null) ||
    new Set(normalizedIds).size !== responseCount
  ) {
    return null;
  }
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    if (
      !isRecord(question) ||
      question.id !== normalizedIds[index] ||
      question.source_id !== expected.sourceId ||
      !practiceReadyQuestion(question)
    ) {
      return null;
    }
  }
  return responseCount;
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

/** Summarizes whether the latest question-job status histogram is complete. */
export function questionJobCompletionState(
  statusCounts: Record<string, number>,
): QuestionJobCompletionState {
  let totalCount = 0;
  let terminalCount = 0;
  let succeededCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const [status, count] of Object.entries(statusCounts)) {
    const normalizedCount = Math.max(0, Math.trunc(numberField(count)));
    totalCount += normalizedCount;
    if (TERMINAL_QUESTION_JOB_STATUSES.has(status)) {
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

function questionJobBlockerFromStatusCounts(
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
