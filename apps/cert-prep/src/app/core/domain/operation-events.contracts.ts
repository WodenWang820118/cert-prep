import type {
  DocumentOperationRead,
  DocumentRead,
  DraftGenerationJobRead,
  ManualDraftGenerationOperationRead,
  LLMInstallationRead,
} from './api.contracts';

export interface DocumentOperationEvent {
  readonly operation: DocumentOperationRead;
  readonly document: DocumentRead | null;
}

export interface DraftJobsEvent {
  readonly items: DraftGenerationJobRead[];
}

export type DraftOperationEvent = ManualDraftGenerationOperationRead;
export type LLMInstallationEvent = LLMInstallationRead;

export function isDocumentOperationEventTerminal(
  event: DocumentOperationEvent,
): boolean {
  return ['canceled', 'succeeded', 'failed'].includes(event.operation.status);
}

export function isDraftJobsEventTerminal(event: DraftJobsEvent): boolean {
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

export function isDraftOperationEventTerminal(
  event: DraftOperationEvent,
): boolean {
  return ['canceled', 'succeeded', 'failed'].includes(event.status);
}

export function isLLMInstallationEventTerminal(
  event: LLMInstallationEvent,
): boolean {
  return ['canceled', 'succeeded', 'failed'].includes(event.status);
}
