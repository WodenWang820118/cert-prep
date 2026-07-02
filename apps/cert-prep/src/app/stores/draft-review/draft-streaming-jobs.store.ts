import { computed, inject, Injectable, signal } from '@angular/core';
import { CERT_PREP_API } from '../../cert-prep-api';
import type { DocumentRead, DraftGenerationJobRead } from '../../cert-prep-api';
import type { DraftJobSummary } from './contracts/draft-review.contracts';
import { ProjectStore } from '../project.store';
import { SourceImportStore } from '../source-import/source-import.store';

const STREAMING_DRAFT_POLL_INTERVAL_MS = 1500;

@Injectable({ providedIn: 'root' })
export class DraftStreamingJobsStore {
  private readonly api = inject(CERT_PREP_API);
  private readonly projects = inject(ProjectStore);
  private readonly sourceImport = inject(SourceImportStore);
  private draftJobsDocumentKey: string | null = null;
  private streamingDraftPollKey: string | null = null;
  private streamingDraftPollTimer: ReturnType<typeof setTimeout> | null = null;

  readonly draftJobs = signal<DraftGenerationJobRead[]>([]);
  readonly draftJobSummary = computed(() =>
    this.summarizeDraftJobs(this.draftJobs()),
  );
  readonly canRetryDraftJobs = computed(() => {
    const summary = this.draftJobSummary();
    return summary.skipped > 0 || summary.failed > 0;
  });

  reset(): void {
    this.draftJobs.set([]);
    this.draftJobsDocumentKey = null;
    this.stopPolling();
  }

  syncPolling(
    projectId: string | null,
    document: DocumentRead | null,
    loadDrafts: (projectId: string) => Promise<void>,
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
    loadDrafts: (projectId: string) => Promise<void>,
  ): void {
    const nextKey = `${projectId}:${documentId}`;
    if (this.streamingDraftPollKey !== nextKey) {
      this.stopPolling({ clearJobs: true });
      this.streamingDraftPollKey = nextKey;
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

  hasActiveDraftJobs(jobs: DraftGenerationJobRead[]): boolean {
    return jobs.some((job) => ['pending', 'running'].includes(job.status));
  }

  private schedulePolling(
    projectId: string,
    documentId: string,
    loadDrafts: (projectId: string) => Promise<void>,
  ): void {
    this.streamingDraftPollTimer = setTimeout(() => {
      this.streamingDraftPollTimer = null;
      void this.pollStreamingDrafts(projectId, documentId, loadDrafts);
    }, STREAMING_DRAFT_POLL_INTERVAL_MS);
  }

  private async pollStreamingDrafts(
    projectId: string,
    documentId: string,
    loadDrafts: (projectId: string) => Promise<void>,
  ): Promise<void> {
    if (this.streamingDraftPollKey !== `${projectId}:${documentId}`) {
      return;
    }

    try {
      await Promise.all([
        loadDrafts(projectId),
        this.loadDraftJobs(projectId, documentId).catch(() => undefined),
      ]);
    } catch {
      this.stopPolling();
      return;
    }

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

  private isCurrentProjectDocument(projectId: string, documentId: string): boolean {
    return (
      this.projects.selectedProjectId() === projectId &&
      this.sourceImport.activeDocument()?.id === documentId
    );
  }

  private summarizeDraftJobs(jobs: DraftGenerationJobRead[]): DraftJobSummary {
    const total = jobs.length;
    const active = jobs.filter((job) =>
      ['pending', 'running'].includes(job.status),
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
}
