import { computed, inject, Injectable, signal } from '@angular/core';
import { forkJoin, from, map, Observable, Subscription, tap } from 'rxjs';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import type { DocumentRead, DraftGenerationJobRead } from '../../contracts/api.contracts';
import { isDraftJobsEventTerminal } from '../../contracts/operation-events.contracts';
import type { DraftJobsEvent } from '../../contracts/operation-events.contracts';
import { CertPrepSseClient } from '../../services/cert-prep-sse-client.service';
import type { DraftJobSummary } from './contracts/draft-review.contracts';
import { OperationStore } from '../operation.store';
import { ProjectStore } from '../project.store';
import { SourceImportStore } from '../source-import/source-import.store';

@Injectable({ providedIn: 'root' })
export class DraftStreamingJobsStore {
  private readonly api = inject(CERT_PREP_API);
  private readonly operations = inject(OperationStore);
  private readonly projects = inject(ProjectStore);
  private readonly sourceImport = inject(SourceImportStore);
  private readonly sse = inject(CertPrepSseClient);
  private draftJobsDocumentKey: string | null = null;
  private streamingKey: string | null = null;
  private streamingSubscription: Subscription | null = null;
  private settledKey: string | null = null;
  private streamTerminalSeen = false;

  readonly draftJobs = signal<DraftGenerationJobRead[]>([]);
  readonly streamError = signal<string | null>(null);
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
    this.stopStreaming();
    this.resetStreamError();
  }

  syncStreaming(
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
      this.streamingKey === documentKey &&
      this.hasActiveDraftJobs(this.draftJobs());
    const shouldStream =
      documentKey !== null &&
      ((document?.status === 'processing' && document.chunks_count > 0) ||
        hasActiveJobs);

    if (shouldStream && document !== null && projectId !== null) {
      this.ensureStreaming(projectId, document.id, loadDrafts);
    } else if (documentKey === null) {
      this.stopStreaming({ clearJobs: true });
    } else if (
      this.draftJobsDocumentKey !== null &&
      this.draftJobsDocumentKey !== documentKey
    ) {
      this.stopStreaming({ clearJobs: true });
    } else if (!hasActiveJobs) {
      this.stopStreaming();
    }
  }

  setDraftJobs(jobs: DraftGenerationJobRead[]): void {
    this.draftJobs.set(jobs);
  }

  ensureStreaming(
    projectId: string,
    documentId: string,
    loadDrafts: (projectId: string) => void,
  ): void {
    const nextKey = `${projectId}:${documentId}`;
    if (
      this.streamingKey === nextKey &&
      (this.streamingSubscription !== null || this.settledKey === nextKey)
    ) {
      return;
    }
    this.stopStreaming();
    this.streamingKey = nextKey;
    this.settledKey = null;
    this.streamTerminalSeen = false;
    this.resetStreamError();
    loadDrafts(projectId);
    this.loadDraftJobs(projectId, documentId).subscribe({
      next: () => this.startStreaming(projectId, documentId, loadDrafts),
      error: () => this.handleStreamError(nextKey),
    });
  }

  stopStreaming(options: { clearJobs?: boolean } = {}): void {
    this.streamingSubscription?.unsubscribe();
    this.streamingSubscription = null;
    this.streamingKey = null;
    this.settledKey = null;
    this.streamTerminalSeen = false;
    if (options.clearJobs) {
      this.draftJobs.set([]);
      this.draftJobsDocumentKey = null;
      this.resetStreamError();
    }
  }

  loadDraftJobs(projectId: string, documentId: string): Observable<void> {
    const documentKey = `${projectId}:${documentId}`;
    return from(this.api.listDocumentDraftJobs(projectId, documentId)).pipe(
      tap((jobs) => {
        if (!this.isCurrentProjectDocument(projectId, documentId)) return;
        this.draftJobsDocumentKey = documentKey;
        this.draftJobs.set(jobs.items);
      }),
      map(() => undefined),
    );
  }

  retryStreaming(
    projectId: string,
    documentId: string,
    loadDrafts: (projectId: string) => void,
  ): void {
    this.stopStreaming();
    const key = `${projectId}:${documentId}`;
    this.streamingKey = key;
    this.settledKey = null;
    this.resetStreamError();
    loadDrafts(projectId);
    this.startStreaming(projectId, documentId, loadDrafts);
  }

  cancelActiveDraftJobs(): void {
    const projectId = this.projects.selectedProjectId();
    const documentId = this.sourceImport.activeDocument()?.id ?? null;
    if (projectId === null || documentId === null || this.cancelingDraftJobs()) {
      return;
    }
    const jobs = this.draftJobs().filter(
      (job) =>
        job.cancellable && ['pending', 'running'].includes(job.status),
    );
    if (jobs.length === 0) return;

    this.cancelingDraftJobs.set(true);
    forkJoin(
      jobs.map((job) =>
        from(this.api.cancelDocumentDraftJob(projectId, documentId, job.id)),
      ),
    ).subscribe({
      next: (canceled) => {
        if (!this.isCurrentProjectDocument(projectId, documentId)) return;
        const replacements = new Map(canceled.map((job) => [job.id, job]));
        this.draftJobs.update((current) =>
          current.map((job) => replacements.get(job.id) ?? job),
        );
        if (this.hasActiveDraftJobs(this.draftJobs())) {
          this.retryStreaming(projectId, documentId, () => undefined);
        }
        this.cancelingDraftJobs.set(false);
      },
      error: (error: unknown) => {
        this.operations.fail(this.errorMessage(error));
        this.cancelingDraftJobs.set(false);
      },
    });
  }

  hasActiveDraftJobs(jobs: DraftGenerationJobRead[]): boolean {
    return jobs.some((job) =>
      ['pending', 'running', 'cancel_requested'].includes(job.status),
    );
  }

  private startStreaming(
    projectId: string,
    documentId: string,
    loadDrafts: (projectId: string) => void,
  ): void {
    const key = `${projectId}:${documentId}`;
    if (this.streamingKey !== key || this.streamingSubscription !== null) return;
    this.streamingSubscription = this.sse
      .streamJson<DraftJobsEvent>(
        `/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}/draft-jobs/events`,
        'draft-jobs',
        { isTerminal: isDraftJobsEventTerminal },
      )
      .subscribe({
        next: (event) => {
          if (!this.isCurrentProjectDocument(projectId, documentId)) return;
          this.draftJobsDocumentKey = key;
          this.draftJobs.set(event.items);
          this.streamTerminalSeen ||= isDraftJobsEventTerminal(event);
          loadDrafts(projectId);
        },
        error: () => this.handleStreamError(key),
        complete: () => {
          if (this.streamingKey === key) {
            this.streamingSubscription = null;
            if (this.streamTerminalSeen) {
              this.settledKey = key;
            } else {
              this.handleStreamError(key);
            }
          }
        },
      });
  }

  private handleStreamError(key: string): void {
    if (this.streamingKey !== key) return;
    this.streamingSubscription = null;
    this.streamError.set(
      'Question generation progress could not be refreshed. Retry the event stream.',
    );
  }

  private resetStreamError(): void {
    this.streamError.set(null);
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
      return { total, active, succeeded, skipped, failed, generatedCount, label: 'No question jobs', detail: 'Waiting for parsed pages.', severity: 'secondary' };
    }
    if (active > 0) {
      return { total, active, succeeded, skipped, failed, generatedCount, label: `Generating ${active}/${total}`, detail: `${generatedCount} questions ready so far.`, severity: 'info' };
    }
    if (failed > 0) {
      return { total, active, succeeded, skipped, failed, generatedCount, label: 'Question generation needs attention', detail: `${failed} job${failed === 1 ? '' : 's'} failed.`, severity: 'danger' };
    }
    if (skipped > 0 && succeeded === 0) {
      const missingModel = jobs.some((job) => job.status === 'skipped_missing_model');
      return { total, active, succeeded, skipped, failed, generatedCount, label: missingModel ? 'Model missing' : 'Reasoning unavailable', detail: `${skipped} job${skipped === 1 ? '' : 's'} skipped.`, severity: 'warn' };
    }
    if (succeeded > 0) {
      return { total, active, succeeded, skipped, failed, generatedCount, label: `${generatedCount} questions ready`, detail: `${succeeded}/${total} jobs completed.`, severity: skipped > 0 ? 'warn' : 'success' };
    }
    return { total, active, succeeded, skipped, failed, generatedCount, label: 'Question jobs settled', detail: `${total} jobs completed without questions.`, severity: 'secondary' };
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) return error.message;
    return 'Question generation could not be canceled.';
  }
}
