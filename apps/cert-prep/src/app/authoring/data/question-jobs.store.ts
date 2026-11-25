import { computed, inject, Injectable, signal } from '@angular/core';
import { forkJoin, from, map, Observable, Subscription, tap } from 'rxjs';
import { CERT_PREP_API } from '../../core/data';
import type { DocumentRead, QuestionGenerationJobRead } from '../../core/domain';
import { isQuestionJobsEventTerminal } from '../../core/domain';
import type { QuestionJobsEvent } from '../../core/domain';
import { CertPrepSseClient } from '../../core/data';
import type { QuestionJobSummary } from '../domain';
import { OperationStore } from '../../core/data';
import { ProjectStore } from '../../projects/data';
import { SourceImportStore } from '../../source-library/data';

@Injectable({ providedIn: 'root' })
export class QuestionJobsStore {
  private readonly api = inject(CERT_PREP_API);
  private readonly operations = inject(OperationStore);
  private readonly projects = inject(ProjectStore);
  private readonly sourceImport = inject(SourceImportStore);
  private readonly sse = inject(CertPrepSseClient);
  private questionJobsDocumentKey: string | null = null;
  private streamDocumentKey: string | null = null;
  private streamSubscription: Subscription | null = null;
  private settledKey: string | null = null;
  private streamTerminalSeen = false;

  readonly questionJobs = signal<QuestionGenerationJobRead[]>([]);
  readonly streamError = signal<string | null>(null);
  readonly cancelingQuestionJobs = signal(false);
  readonly questionJobSummary = computed(() =>
    this.summarizeQuestionJobs(this.questionJobs()),
  );
  readonly canRetryQuestionJobs = computed(() => {
    const summary = this.questionJobSummary();
    return summary.skipped > 0 || summary.failed > 0;
  });
  readonly canCancelActiveQuestionJobs = computed(() =>
    this.questionJobs().some(
      (job) =>
        job.cancellable && ['pending', 'running'].includes(job.status),
    ),
  );

  reset(): void {
    this.questionJobs.set([]);
    this.questionJobsDocumentKey = null;
    this.stopJobStream();
    this.resetStreamError();
  }

  syncJobStream(
    projectId: string | null,
    document: DocumentRead | null,
    loadQuestions: (projectId: string) => void,
  ): void {
    const documentKey =
      projectId !== null && document !== null
        ? `${projectId}:${document.id}`
        : null;
    const hasActiveJobs =
      documentKey !== null &&
      this.streamDocumentKey === documentKey &&
      this.hasActiveQuestionJobs(this.questionJobs());
    const shouldStream =
      documentKey !== null &&
      ((document?.status === 'processing' && document.chunks_count > 0) ||
        hasActiveJobs);

    if (shouldStream && document !== null && projectId !== null) {
      this.ensureJobStream(projectId, document.id, loadQuestions);
    } else if (documentKey === null) {
      this.stopJobStream({ clearJobs: true });
    } else if (
      this.questionJobsDocumentKey !== null &&
      this.questionJobsDocumentKey !== documentKey
    ) {
      this.stopJobStream({ clearJobs: true });
    } else if (!hasActiveJobs) {
      this.stopJobStream();
    }
  }

  setQuestionJobs(jobs: QuestionGenerationJobRead[]): void {
    this.questionJobs.set(jobs);
  }

  ensureJobStream(
    projectId: string,
    documentId: string,
    loadQuestions: (projectId: string) => void,
  ): void {
    const nextKey = `${projectId}:${documentId}`;
    if (
      this.streamDocumentKey === nextKey &&
      (this.streamSubscription !== null || this.settledKey === nextKey)
    ) {
      return;
    }
    this.stopJobStream();
    this.streamDocumentKey = nextKey;
    this.settledKey = null;
    this.streamTerminalSeen = false;
    this.resetStreamError();
    loadQuestions(projectId);
    this.loadQuestionJobs(projectId, documentId).subscribe({
      next: () => this.startJobStream(projectId, documentId, loadQuestions),
      error: () => this.handleStreamError(nextKey),
    });
  }

  stopJobStream(options: { clearJobs?: boolean } = {}): void {
    this.streamSubscription?.unsubscribe();
    this.streamSubscription = null;
    this.streamDocumentKey = null;
    this.settledKey = null;
    this.streamTerminalSeen = false;
    if (options.clearJobs) {
      this.questionJobs.set([]);
      this.questionJobsDocumentKey = null;
      this.resetStreamError();
    }
  }

  loadQuestionJobs(projectId: string, documentId: string): Observable<void> {
    const documentKey = `${projectId}:${documentId}`;
    return from(this.api.listDocumentQuestionJobs(projectId, documentId)).pipe(
      tap((jobs) => {
        if (!this.isCurrentProjectDocument(projectId, documentId)) return;
        this.questionJobsDocumentKey = documentKey;
        this.questionJobs.set(jobs.items);
      }),
      map(() => undefined),
    );
  }

  retryJobStream(
    projectId: string,
    documentId: string,
    loadQuestions: (projectId: string) => void,
  ): void {
    this.stopJobStream();
    const key = `${projectId}:${documentId}`;
    this.streamDocumentKey = key;
    this.settledKey = null;
    this.resetStreamError();
    loadQuestions(projectId);
    this.startJobStream(projectId, documentId, loadQuestions);
  }

  cancelActiveQuestionJobs(): void {
    const projectId = this.projects.selectedProjectId();
    const documentId = this.sourceImport.activeDocument()?.id ?? null;
    if (projectId === null || documentId === null || this.cancelingQuestionJobs()) {
      return;
    }
    const jobs = this.questionJobs().filter(
      (job) =>
        job.cancellable && ['pending', 'running'].includes(job.status),
    );
    if (jobs.length === 0) return;

    this.cancelingQuestionJobs.set(true);
    forkJoin(
      jobs.map((job) =>
        from(this.api.cancelDocumentQuestionJob(projectId, documentId, job.id)),
      ),
    ).subscribe({
      next: (canceled) => {
        if (!this.isCurrentProjectDocument(projectId, documentId)) return;
        const replacements = new Map(canceled.map((job) => [job.id, job]));
        this.questionJobs.update((current) =>
          current.map((job) => replacements.get(job.id) ?? job),
        );
        if (this.hasActiveQuestionJobs(this.questionJobs())) {
          this.retryJobStream(projectId, documentId, () => undefined);
        }
        this.cancelingQuestionJobs.set(false);
      },
      error: (error: unknown) => {
        this.operations.fail(this.errorMessage(error));
        this.cancelingQuestionJobs.set(false);
      },
    });
  }

  hasActiveQuestionJobs(jobs: QuestionGenerationJobRead[]): boolean {
    return jobs.some((job) =>
      ['pending', 'running', 'cancel_requested'].includes(job.status),
    );
  }

  private startJobStream(
    projectId: string,
    documentId: string,
    loadQuestions: (projectId: string) => void,
  ): void {
    const key = `${projectId}:${documentId}`;
    if (this.streamDocumentKey !== key || this.streamSubscription !== null) return;
    this.streamSubscription = this.sse
      .streamJson<QuestionJobsEvent>(
        `/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}/question-jobs/events`,
        'question-jobs',
        { isTerminal: isQuestionJobsEventTerminal },
      )
      .subscribe({
        next: (event) => {
          if (!this.isCurrentProjectDocument(projectId, documentId)) return;
          this.questionJobsDocumentKey = key;
          this.questionJobs.set(event.items);
          this.streamTerminalSeen ||= isQuestionJobsEventTerminal(event);
          loadQuestions(projectId);
        },
        error: () => this.handleStreamError(key),
        complete: () => {
          if (this.streamDocumentKey === key) {
            this.streamSubscription = null;
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
    if (this.streamDocumentKey !== key) return;
    this.streamSubscription = null;
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

  private summarizeQuestionJobs(jobs: QuestionGenerationJobRead[]): QuestionJobSummary {
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
