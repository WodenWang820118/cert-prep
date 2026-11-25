import type {
  SourceOperationRead,
  SourceRead,
  QuestionGenerationJobRead,
  ManualQuestionGenerationRead,
  LLMInstallationRead,
} from './api.contracts';

export interface SourceOperationEvent {
  readonly operation: SourceOperationRead;
  readonly source: SourceRead | null;
}

export interface QuestionJobsEvent {
  readonly items: QuestionGenerationJobRead[];
}

export type QuestionGenerationEvent = ManualQuestionGenerationRead;
export type LLMInstallationEvent = LLMInstallationRead;

export function isSourceOperationEventTerminal(
  event: SourceOperationEvent,
): boolean {
  return ['canceled', 'succeeded', 'failed'].includes(event.operation.status);
}

export function isQuestionJobsEventTerminal(event: QuestionJobsEvent): boolean {
  return (
    event.items.length > 0 &&
    event.items.every((job) =>
      [
        'succeeded',
        'failed',
        'canceled',
        'skipped_provider_unavailable',
        'skipped_missing_model',
      ].includes(job.status),
    )
  );
}

export function isQuestionGenerationEventTerminal(
  event: QuestionGenerationEvent,
): boolean {
  return ['canceled', 'succeeded', 'failed'].includes(event.status);
}

export function isLLMInstallationEventTerminal(
  event: LLMInstallationEvent,
): boolean {
  return ['canceled', 'succeeded', 'failed'].includes(event.status);
}
