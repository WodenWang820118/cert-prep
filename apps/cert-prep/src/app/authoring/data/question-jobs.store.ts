import { computed, inject, Injectable, signal } from '@angular/core';
import { forkJoin, from, map, Observable, Subscription, tap } from 'rxjs';
import { CERT_PREP_API } from '../../core/data';
import type { SourceRead, QuestionGenerationJobRead } from '../../core/domain';
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
  private questionJobsSourceKey: string | null = null;
  private streamSourceKey: string | null = null;
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
    this.questionJobsSourceKey = null;
    this.stopJobStream();
    this.resetStreamError();
  }

  syncJobStream(
    projectId: string | null,
    source: SourceRead | null,
    loadQuestions: (projectId: string) => void,
  ): void {
    const sourceKey =
      projectId !== null && source !== null
        ? `${projectId}:${source.id}`
        : null;
    const hasActiveJobs =
      sourceKey !== null &&
      this.streamSourceKey === sourceKey &&
      this.hasActiveQuestionJobs(this.questionJobs());
    const shouldStream =
      sourceKey !== null &&
      ((source?.status === 'processing' && source.chunks_count > 0) ||
        hasActiveJobs);

    if (shouldStream && source !== null && projectId !== null) {
      this.ensureJobStream(projectId, source.id, loadQuestions);
    } else if (sourceKey === null) {
      this.stopJobStream({ clearJobs: true });
    } else if (
      this.questionJobsSourceKey !== null &&
      this.questionJobsSourceKey !== sourceKey
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
    sourceId: string,
    loadQuestions: (projectId: string) => void,
  ): void {
    const nextKey = `${projectId}:${sourceId}`;
    if (
      this.streamSourceKey === nextKey &&
      (this.streamSubscription !== null || this.settledKey === nextKey)
    ) {
      return;
    }
    this.stopJobStream();
    this.streamSourceKey = nextKey;
    this.settledKey = null;
    this.streamTerminalSeen = false;
    this.resetStreamError();
    loadQuestions(projectId);
    this.loadQuestionJobs(projectId, sourceId).subscribe({
      next: () => this.startJobStream(projectId, sourceId, loadQuestions),
      error: () => this.handleStreamError(nextKey),
    });
  }

  stopJobStream(options: { clearJobs?: boolean } = {}): void {
    this.streamSubscription?.unsubscribe();
    this.streamSubscription = null;
    this.streamSourceKey = null;
    this.settledKey = null;
    this.streamTerminalSeen = false;
    if (options.clearJobs) {
      this.questionJobs.set([]);
      this.questionJobsSourceKey = null;
      this.resetStreamError();
    }
  }

  loadQuestionJobs(projectId: string, sourceId: string): Observable<void> {
    const sourceKey = `${projectId}:${sourceId}`;
    return from(this.api.listSourceQuestionJobs(projectId, sourceId)).pipe(
      tap((jobs) => {
        if (!this.isCurrentProjectSource(projectId, sourceId)) return;
        this.questionJobsSourceKey = sourceKey;
        this.questionJobs.set(jobs.items);
      }),
      map(() => undefined),
    );
  }

  retryJobStream(
    projectId: string,
    sourceId: string,
    loadQuestions: (projectId: string) => void,
  ): void {
    this.stopJobStream();
    const key = `${projectId}:${sourceId}`;
    this.streamSourceKey = key;
    this.settledKey = null;
    this.resetStreamError();
    loadQuestions(projectId);
    this.startJobStream(projectId, sourceId, loadQuestions);
  }

  cancelActiveQuestionJobs(): void {
    const projectId = this.projects.selectedProjectId();
    const sourceId = this.sourceImport.activeSource()?.id ?? null;
    if (projectId === null || sourceId === null || this.cancelingQuestionJobs()) {
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
        from(this.api.cancelSourceQuestionJob(projectId, sourceId, job.id)),
      ),
    ).subscribe({
      next: (canceled) => {
        if (!this.isCurrentProjectSource(projectId, sourceId)) return;
        const replacements = new Map(canceled.map((job) => [job.id, job]));
        this.questionJobs.update((current) =>
          current.map((job) => replacements.get(job.id) ?? job),
        );
        if (this.hasActiveQuestionJobs(this.questionJobs())) {
          this.retryJobStream(projectId, sourceId, () => undefined);
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
    sourceId: string,
    loadQuestions: (projectId: string) => void,
  ): void {
    const key = `${projectId}:${sourceId}`;
    if (this.streamSourceKey !== key || this.streamSubscription !== null) return;
    this.streamSubscription = this.sse
      .streamJson<QuestionJobsEvent>(
        `/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}/question-jobs/events`,
        'question-jobs',
        { isTerminal: isQuestionJobsEventTerminal },
      )
      .subscribe({
        next: (event) => {
          if (!this.isCurrentProjectSource(projectId, sourceId)) return;
          this.questionJobsSourceKey = key;
          this.questionJobs.set(event.items);
          this.streamTerminalSeen ||= isQuestionJobsEventTerminal(event);
          loadQuestions(projectId);
        },
        error: () => this.handleStreamError(key),
        complete: () => {
          if (this.streamSourceKey === key) {
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
    if (this.streamSourceKey !== key) return;
    this.streamSubscription = null;
    this.streamError.set(
      'Question generation progress could not be refreshed. Retry the event stream.',
    );
  }

  private resetStreamError(): void {
    this.streamError.set(null);
  }

  private isCurrentProjectSource(projectId: string, sourceId: string): boolean {
    return (
      this.projects.selectedProjectId() === projectId &&
      this.sourceImport.activeSource()?.id === sourceId
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
