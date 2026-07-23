import { computed, inject, Injectable, signal } from '@angular/core';
import { CERT_PREP_API } from '../../cert-prep-api';
import type { DocumentRead, DraftGenerationJobRead } from '../../cert-prep-api';
import type { DraftJobSummary } from './contracts/draft-review.contracts';
import { OperationStore } from '../operation.store';
import { ProjectStore } from '../project.store';
import { SourceImportStore } from '../source-import/source-import.store';

const STREAMING_DRAFT_POLL_INTERVAL_MS = 1500;
const POLL_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

@Injectable({ providedIn: 'root' })
export class DraftStreamingJobsStore {
  private readonly api = inject(CERT_PREP_API);
  private readonly operations = inject(OperationStore);
  private readonly projects = inject(ProjectStore);
  private readonly sourceImport = inject(SourceImportStore);
  private draftJobsDocumentKey: string | null = null;
  private streamingDraftPollKey: string | null = null;
  private streamingDraftPollTimer: ReturnType<typeof setTimeout> | null = null;
  private streamingDraftPollFailureCount = 0;

  readonly draftJobs = signal<DraftGenerationJobRead[]>([]);
  readonly pollingError = signal<string | null>(null);
  readonly cancelingDraftJobs = signal(false);
  readonly draftJobSummary = computed(() =>
    this.summarizeDraftJobs(this.draftJobs()),
  );
  readonly canRetryDraftJobs = computed(() => {
    const summary = this.draftJobSummary();
    return summary.skipped > 0 || summary.failed > 0;
  });
  readonly canCancelActiveDraftJobs = computed(() =>
    this.draftJobs().some(
      (job) =>
        job.cancellable && ['pending', 'running'].includes(job.status),
    ),
  );

  reset(): void {
    this.draftJobs.set([]);
    this.draftJobsDocumentKey = null;
    this.stopPolling();
    this.resetPollingFailure();
  }

  syncPolling(
    projectId: string | null,
    document: DocumentRead | null,
    loadDrafts: (projectId: string) => void,
  ): void {
    const documentKey =
      projectId !== null && document !== null
        ? `${projectId}:${document.id}`
        : null;
    const hasActiveJobs =
      documentKey !== null &&
      this.streamingDraftPollKey === documentKey &&
      this.hasActiveDraftJobs(this.draftJobs());
    const shouldPoll =
      documentKey !== null &&
      ((document?.status === 'processing' && document.chunks_count > 0) ||
        hasActiveJobs);

    if (shouldPoll && document !== null && projectId !== null) {
      this.ensurePolling(projectId, document.id, loadDrafts);
    } else if (documentKey === null) {
      this.stopPolling({ clearJobs: true });
    } else if (
      this.draftJobsDocumentKey !== null &&
      this.draftJobsDocumentKey !== documentKey
    ) {
      this.stopPolling({ clearJobs: true });
    } else {
      this.stopPolling();
    }
  }

  setDraftJobs(jobs: DraftGenerationJobRead[]): void {
    this.draftJobs.set(jobs);
  }

  ensurePolling(
    projectId: string,
    documentId: string,
    loadDrafts: (projectId: string) => void,
  ): void {
    const nextKey = `${projectId}:${documentId}`;
    if (this.streamingDraftPollKey !== nextKey) {
      this.stopPolling({ clearJobs: true });
      this.streamingDraftPollKey = nextKey;
      this.resetPollingFailure();
      void this.pollStreamingDrafts(projectId, documentId, loadDrafts);
      return;
    }

    if (this.streamingDraftPollTimer === null) {
      this.schedulePolling(projectId, documentId, loadDrafts);
    }
  }

  stopPolling(options: { clearJobs?: boolean } = {}): void {
    if (this.streamingDraftPollTimer !== null) {
      clearTimeout(this.streamingDraftPollTimer);
      this.streamingDraftPollTimer = null;
    }
    this.streamingDraftPollKey = null;
    if (options.clearJobs) {
      this.draftJobs.set([]);
      this.draftJobsDocumentKey = null;
      this.resetPollingFailure();
    }
  }

  async loadDraftJobs(projectId: string, documentId: string): Promise<void> {
    const documentKey = `${projectId}:${documentId}`;
    const jobs = await this.api.listDocumentDraftJobs(projectId, documentId);
    if (!this.isCurrentProjectDocument(projectId, documentId)) {
      return;
    }

    this.draftJobsDocumentKey = documentKey;
    this.draftJobs.set(jobs.items);
  }

  retryPolling(
    projectId: string,
    documentId: string,
    loadDrafts: (projectId: string) => void,
  ): void {
    this.stopPolling();
    this.streamingDraftPollKey = `${projectId}:${documentId}`;
    this.resetPollingFailure();
    void this.pollStreamingDrafts(projectId, documentId, loadDrafts);
  }

  async cancelActiveDraftJobs(): Promise<void> {
    const projectId = this.projects.selectedProjectId();
    const documentId = this.sourceImport.activeDocument()?.id ?? null;
    if (projectId === null || documentId === null || this.cancelingDraftJobs()) {
      return;
    }
    const jobs = this.draftJobs().filter(
      (job) =>
        job.cancellable && ['pending', 'running'].includes(job.status),
    );
    if (jobs.length === 0) {
      return;
    }

    this.cancelingDraftJobs.set(true);
    try {
      const canceled = await Promise.all(
        jobs.map((job) =>
          this.api.cancelDocumentDraftJob(projectId, documentId, job.id),
        ),
      );
      if (!this.isCurrentProjectDocument(projectId, documentId)) {
        return;
      }
      const replacements = new Map(canceled.map((job) => [job.id, job]));
      this.draftJobs.update((current) =>
        current.map((job) => replacements.get(job.id) ?? job),
      );
      if (this.hasActiveDraftJobs(this.draftJobs())) {
        this.stopPolling();
        this.streamingDraftPollKey = `${projectId}:${documentId}`;
        this.resetPollingFailure();
        this.schedulePolling(projectId, documentId, async () => undefined);
      }
    } catch (error) {
      this.operations.fail(this.errorMessage(error));
    } finally {
      this.cancelingDraftJobs.set(false);
    }
  }

  hasActiveDraftJobs(jobs: DraftGenerationJobRead[]): boolean {
    return jobs.some((job) =>
      ['pending', 'running', 'cancel_requested'].includes(job.status),
    );
  }

  private schedulePolling(
    projectId: string,
    documentId: string,
    loadDrafts: (projectId: string) => void,
    delayMs = STREAMING_DRAFT_POLL_INTERVAL_MS,
  ): void {
    this.streamingDraftPollTimer = setTimeout(() => {
      this.streamingDraftPollTimer = null;
      void this.pollStreamingDrafts(projectId, documentId, loadDrafts);
    }, delayMs);
  }

  private async pollStreamingDrafts(
    projectId: string,
    documentId: string,
    loadDrafts: (projectId: string) => void,
  ): Promise<void> {
    if (this.streamingDraftPollKey !== `${projectId}:${documentId}`) {
      return;
    }

    try {
      loadDrafts(projectId);
      await this.loadDraftJobs(projectId, documentId);
    } catch {
      this.handlePollingFailure(projectId, documentId, loadDrafts);
      return;
    }

    this.resetPollingFailure();

    const document = this.sourceImport.activeDocument();
    const selectedProjectId = this.projects.selectedProjectId();
    if (
      selectedProjectId === projectId &&
      document?.id === documentId &&
      (document.status === 'processing' ||
        this.hasActiveDraftJobs(this.draftJobs()))
    ) {
      this.schedulePolling(projectId, documentId, loadDrafts);
    } else {
      this.stopPolling();
    }
  }

  private handlePollingFailure(
    projectId: string,
    documentId: string,
    loadDrafts: (projectId: string) => void,
  ): void {
    if (this.streamingDraftPollKey !== `${projectId}:${documentId}`) {
      return;
    }

    const delay = POLL_RETRY_DELAYS_MS[this.streamingDraftPollFailureCount];
    if (delay !== undefined) {
      this.streamingDraftPollFailureCount += 1;
      this.schedulePolling(projectId, documentId, loadDrafts, delay);
      return;
    }

    this.stopPolling();
    this.pollingError.set(
      'Question generation progress could not be refreshed. The local job may still be running.',
    );
  }

  private resetPollingFailure(): void {
    this.streamingDraftPollFailureCount = 0;
    this.pollingError.set(null);
  }

  private isCurrentProjectDocument(projectId: string, documentId: string): boolean {
    return (
      this.projects.selectedProjectId() === projectId &&
      this.sourceImport.activeDocument()?.id === documentId
    );
  }

  private summarizeDraftJobs(jobs: DraftGenerationJobRead[]): DraftJobSummary {
    const total = jobs.length;
    const active = jobs.filter((job) =>
      ['pending', 'running', 'cancel_requested'].includes(job.status),
    ).length;
    const succeeded = jobs.filter((job) => job.status === 'succeeded').length;
    const skipped = jobs.filter((job) =>
      ['skipped_missing_model', 'skipped_provider_unavailable'].includes(
        job.status,
      ),
    ).length;
    const failed = jobs.filter((job) => job.status === 'failed').length;
    const generatedCount = jobs.reduce(
      (count, job) => count + job.generated_count,
      0,
    );

    if (total === 0) {
      return {
        total,
        active,
        succeeded,
        skipped,
        failed,
        generatedCount,
        label: 'No question jobs',
        detail: 'Waiting for parsed pages.',
        severity: 'secondary',
      };
    }
    if (active > 0) {
      return {
        total,
        active,
        succeeded,
        skipped,
        failed,
        generatedCount,
        label: `Generating ${active}/${total}`,
        detail: `${generatedCount} questions ready so far.`,
        severity: 'info',
      };
    }
    if (failed > 0) {
      return {
        total,
        active,
        succeeded,
        skipped,
        failed,
        generatedCount,
        label: 'Question generation needs attention',
        detail: `${failed} job${failed === 1 ? '' : 's'} failed.`,
        severity: 'danger',
      };
    }
    if (skipped > 0 && succeeded === 0) {
      const missingModel = jobs.some(
        (job) => job.status === 'skipped_missing_model',
      );
      return {
        total,
        active,
        succeeded,
        skipped,
        failed,
        generatedCount,
        label: missingModel ? 'Model missing' : 'Reasoning unavailable',
        detail: `${skipped} job${skipped === 1 ? '' : 's'} skipped.`,
        severity: 'warn',
      };
    }
    if (succeeded > 0) {
      return {
        total,
        active,
        succeeded,
        skipped,
        failed,
        generatedCount,
        label: `${generatedCount} questions ready`,
        detail: `${succeeded}/${total} jobs completed.`,
        severity: skipped > 0 ? 'warn' : 'success',
      };
    }

    return {
      total,
      active,
      succeeded,
      skipped,
      failed,
      generatedCount,
      label: 'Question jobs settled',
      detail: `${total} jobs completed without questions.`,
      severity: 'secondary',
    };
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }
    return 'Question generation could not be canceled.';
  }
}
