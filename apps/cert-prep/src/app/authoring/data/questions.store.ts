import {
  computed,
  effect,
  inject,
  Injectable,
  signal,
  untracked,
} from '@angular/core';
import { from, Subscription } from 'rxjs';
import { CERT_PREP_API } from '../../core/data';
import type {
  ManualQuestionGenerationRead,
  QuestionRead,
} from '../../core/domain';
import { isQuestionGenerationEventTerminal } from '../../core/domain';
import type { QuestionGenerationEvent } from '../../core/domain';
import { CertPrepHttpResourceClient } from '../../core/data';
import { CertPrepSseClient } from '../../core/data';
import type {
  QuestionEdit,
  QuestionGenerationStrategy,
} from '../domain';
import { QuestionEditService } from './question-edit.service';
import { QuestionEditSessionStore } from './question-edit-session.store';
import { QuestionPlayabilityService } from './question-playability.service';
import { QuestionJobsStore } from './question-jobs.store';
import { HealthStore } from '../../runtime/data';
import { OperationStore } from '../../core/data';
import { ProjectStore } from '../../projects/data';
import { SourceImportStore } from '../../source-library/data';

@Injectable({ providedIn: 'root' })
export class QuestionsStore {
  private readonly api = inject(CERT_PREP_API);
  private readonly edits = inject(QuestionEditService);
  private readonly editSession = inject(QuestionEditSessionStore);
  private readonly health = inject(HealthStore);
  private readonly operations = inject(OperationStore);
  private readonly playability = inject(QuestionPlayabilityService);
  private readonly projects = inject(ProjectStore);
  private readonly resources = inject(CertPrepHttpResourceClient);
  private readonly sse = inject(CertPrepSseClient);
  private readonly sourceImport = inject(SourceImportStore);
  private readonly questionJobsStore = inject(QuestionJobsStore);
  private readonly questionsQueryEnabled = signal(false);
  private manualQuestionGenerationStreamSubscription: Subscription | null = null;
  private manualQuestionGenerationStreamTerminalSeen = false;

  readonly questionLimit = signal(3);
  private readonly questionsResource = this.resources.questions(() =>
    this.questionsQueryEnabled() ? this.projects.selectedProjectId() : null,
  );
  readonly questions = signal<QuestionRead[]>([]);
  readonly questionsLoading = this.questionsResource.isLoading;
  readonly questionsError = this.questionsResource.error;
  readonly questionJobs = this.questionJobsStore.questionJobs;
  readonly manualQuestionGeneration = signal<ManualQuestionGenerationRead | null>(
    null,
  );
  readonly manualQuestionGenerationCanceling = signal(false);
  readonly manualQuestionGenerationStreamError = signal<string | null>(null);
  readonly editingQuestionId = this.editSession.editingQuestionId;
  readonly questionEdits = this.editSession.questionEdits;
  readonly playableQuestions = computed(() =>
    this.questions().filter((question) => this.isPlayableQuestion(question)),
  );
  readonly activeSourceQuestions = computed(() => {
    const sourceId = this.sourceImport.activeSourceId();
    return sourceId === null
      ? this.questions()
      : this.questions().filter((question) => question.source_id === sourceId);
  });
  readonly activeSourcePlayableQuestions = computed(() =>
    this.activeSourceQuestions().filter((question) => this.isPlayableQuestion(question)),
  );
  readonly questionJobSummary = this.questionJobsStore.questionJobSummary;
  readonly canRetryQuestionJobs = this.questionJobsStore.canRetryQuestionJobs;
  readonly canCancelActiveQuestionJobs =
    this.questionJobsStore.canCancelActiveQuestionJobs;
  readonly cancelingQuestionJobs = this.questionJobsStore.cancelingQuestionJobs;
  readonly streamError = this.questionJobsStore.streamError;
  readonly isManualQuestionGenerationActive = computed(() => {
    const status = this.manualQuestionGeneration()?.status;
    return ['queued', 'running', 'cancel_requested'].includes(status ?? '');
  });
  readonly isManualQuestionGenerationProgressActive = computed(
    () =>
      this.isManualQuestionGenerationActive() &&
       this.manualQuestionGenerationStreamError() === null,
  );
  readonly canCancelManualQuestionGeneration = computed(() => {
    const operation = this.manualQuestionGeneration();
    return (
      operation !== null &&
      operation.cancellable &&
      ['queued', 'running', 'cancel_requested'].includes(operation.status) &&
      !this.manualQuestionGenerationCanceling()
    );
  });
  private readonly questionResourceSync = effect(() => {
    const questionResourceStatus = this.questionsResource.status();
    if (questionResourceStatus === 'resolved' || questionResourceStatus === 'local') {
      this.questions.set(this.questionsResource.value());
    }
  });

  constructor() {
    effect(() => {
      const projectId = this.projects.selectedProjectId();
      const source = this.sourceImport.activeSource();
      const operation = this.manualQuestionGeneration();
      if (
        operation !== null &&
        (operation.project_id !== projectId || operation.source_id !== source?.id)
      ) {
         this.clearManualQuestionGenerationStream();
         this.manualQuestionGeneration.set(null);
         this.resetManualQuestionGenerationStreamError();
       }
       this.questionJobsStore.syncJobStream(projectId, source, (id) => {
        this.load(id);
      });
    });
    effect(() => {
      // Source Library reports uploads, source selections (the same
      // source again included) and a source becoming active. Reload the
      // project's questions on each, so an upload that finishes after the first
      // question query is not taken for a project without questions (D19).
      const activity = this.sourceImport.sourceActivity();
      if (activity !== null) {
        untracked(() => this.load(activity.projectId));
      }
    });
  }

  load(projectId: string): void {
    if (this.projects.selectedProjectId() !== projectId) {
      return;
    }
    if (!this.questionsQueryEnabled()) {
      this.questionsQueryEnabled.set(true);
      return;
    }
    this.questionsResource.reload();
  }

  reset(): void {
    this.questions.set([]);
    this.questionsResource.set([]);
    this.editSession.reset();
    this.questionJobsStore.reset();
    this.clearManualQuestionGenerationStream();
    this.manualQuestionGeneration.set(null);
    this.resetManualQuestionGenerationStreamError();
  }

  setQuestionLimit(value: string | number): void {
    this.questionLimit.set(this.edits.clampQuestionLimit(value));
  }

  isEditing(question: QuestionRead): boolean {
    return this.editSession.isEditing(question);
  }

  isPlayableQuestion(question: QuestionRead): boolean {
    return this.playability.isPlayableQuestion(question);
  }

  questionEdit(question: QuestionRead): QuestionEdit {
    return this.editSession.questionEdit(question);
  }

  startEdit(question: QuestionRead): void {
    this.editSession.startEdit(question);
  }

  cancelEdit(question: QuestionRead): void {
    this.editSession.cancelEdit(question);
  }

  setEditQuestion(questionId: string, question: string): void {
    this.editSession.setEditQuestion(questionId, this.questions(), question);
  }

  setEditChoice(questionId: string, index: number, choice: string): void {
    this.editSession.setEditChoice(questionId, this.questions(), index, choice);
  }

  addEditChoice(questionId: string): void {
    this.editSession.addEditChoice(questionId, this.questions());
  }

  removeEditChoice(questionId: string, index: number): void {
    this.editSession.removeEditChoice(questionId, this.questions(), index);
  }

  setEditAnswer(questionId: string, answer: string): void {
    this.editSession.setEditAnswer(questionId, this.questions(), answer);
  }

  setEditRationale(questionId: string, rationale: string): void {
    this.editSession.setEditRationale(questionId, this.questions(), rationale);
  }

  generateQuestions(
    strategy: QuestionGenerationStrategy = 'hybrid_reasoning',
  ): void {
    const project = this.projects.selectedProject();
    const source = this.sourceImport.activeSource();
    if (project === null || source === null) {
      this.operations.fail(
        'Upload a source file with extractable text before generating questions.',
      );
      return;
    }

    if (this.isManualQuestionGenerationActive()) {
      return;
    }

    this.operations
      .run(
        'questions',
        strategy === 'deterministic_only'
          ? 'Deterministic question generation queued'
          : 'Reasoning question generation queued',
        (signal) =>
          from(this.api.startManualQuestionGeneration(
            project.id,
            source.id,
            this.generatePayload(strategy),
            { signal },
          )),
      )
      .subscribe((operation) => {
        if (operation === null) {
          this.openMissingAiRuntimePrompt(strategy);
          return;
        }
        this.manualQuestionGeneration.set(operation);
         this.resetManualQuestionGenerationStreamError();
         this.continueManualQuestionGeneration(operation, strategy);
      });
  }

  cancelManualQuestionGeneration(): void {
    const operation = this.manualQuestionGeneration();
    if (operation === null || !this.canCancelManualQuestionGeneration()) {
      return;
    }
    this.manualQuestionGenerationCanceling.set(true);
    from(this.api
      .cancelManualQuestionGeneration(
        operation.project_id,
        operation.source_id,
        operation.id,
      ))
      .subscribe({
        next: (canceled) => {
          if (!this.isCurrentManualQuestionGeneration(operation)) return;
          this.manualQuestionGeneration.set(canceled);
          this.continueManualQuestionGeneration(canceled, operation.strategy as QuestionGenerationStrategy);
          this.manualQuestionGenerationCanceling.set(false);
        },
        error: (error: unknown) => {
          this.operations.fail(this.errorMessage(error));
          this.manualQuestionGenerationCanceling.set(false);
        },
      });
  }

  cancelActiveQuestionJobs(): void {
    this.questionJobsStore.cancelActiveQuestionJobs();
  }

  retryManualQuestionGenerationStream(): void {
    const operation = this.manualQuestionGeneration();
    if (operation === null || !this.isManualQuestionGenerationActive()) {
      return;
    }
    this.clearManualQuestionGenerationStream();
    this.resetManualQuestionGenerationStreamError();
    this.startManualQuestionGenerationStream(operation, operation.strategy as QuestionGenerationStrategy);
  }

  private openMissingAiRuntimePrompt(
    strategy: QuestionGenerationStrategy,
    providerUnavailable = false,
  ): void {
    if (
      strategy !== 'hybrid_reasoning' ||
      (!providerUnavailable &&
        this.operations.errorCode() !== 'provider_unavailable')
    ) {
      return;
    }

    this.health.load();

    if (this.health.canInstallOllama()) {
      this.health.openOllamaInstallConsent();
      return;
    }

    if (this.health.canDownloadModel()) {
      this.health.openModelDownloadConsent();
    }
  }

  retryQuestionJobs(): void {
    const project = this.projects.selectedProject();
    const source = this.sourceImport.activeSource();
    if (project === null || source === null) {
      this.operations.fail('Select a parsed source before retrying question generation.');
      return;
    }

    this.operations
      .run('questions', 'Question generation retry queued', (signal) =>
        from(this.api.retrySourceQuestionJobs(project.id, source.id, { signal })),
      )
      .subscribe((jobs) => {
        if (jobs === null) return;
        this.questionJobsStore.setQuestionJobs(jobs.items);
        this.load(project.id);
        this.sourceImport.refreshUploadedSource(project.id, source.id);
        if (this.questionJobsStore.hasActiveQuestionJobs(jobs.items)) {
          this.questionJobsStore.ensureJobStream(project.id, source.id, (id) => this.load(id));
        }
      });
  }

  retryQuestionStream(): void {
    const project = this.projects.selectedProject();
    const source = this.sourceImport.activeSource();
    if (project === null || source === null) {
      return;
    }

    this.questionJobsStore.retryJobStream(project.id, source.id, (projectId) => {
      this.load(projectId);
    });
  }

  saveQuestion(question: QuestionRead): void {
    const project = this.projects.selectedProject();
    if (project === null) {
      this.operations.fail('Select a project before saving questions.');
      return;
    }

    this.operations
      .run('saveQuestion', 'Question saved', (signal) =>
        from(this.api.updateQuestion(project.id, question.id, this.updatePayload(question), { signal })),
      )
      .subscribe((updated) => {
        if (updated === null) return;
        this.upsertQuestion(updated);
        this.cancelEdit(updated);
      });
  }

  private upsertQuestion(nextQuestion: QuestionRead): void {
    const nextQuestions = (() => {
      const questions = this.questions();
      const existingIndex = questions.findIndex(
        (question) => question.id === nextQuestion.id,
      );
      if (existingIndex === -1) {
        return [nextQuestion, ...questions];
      }

      return questions.map((question, index) =>
        index === existingIndex ? nextQuestion : question,
      );
    })();
    this.questions.set(nextQuestions);
    this.questionsResource.set(nextQuestions);
  }

  private updatePayload(question: QuestionRead) {
    return this.editSession.updatePayload(question);
  }

  private generatePayload(strategy: QuestionGenerationStrategy) {
    return this.edits.generatePayload(this.questionLimit(), strategy);
  }

  private continueManualQuestionGeneration(
    operation: ManualQuestionGenerationRead,
    strategy: QuestionGenerationStrategy,
  ): void {
    if (operation.status === 'succeeded') {
      this.completeManualQuestionGeneration(operation);
      return;
    }
    if (operation.status === 'failed') {
      this.operations.fail(
        operation.error ?? 'Question generation did not complete.',
      );
      void this.openMissingAiRuntimePrompt(strategy, true);
      return;
    }
    if (operation.status === 'canceled') {
      return;
    }
    this.startManualQuestionGenerationStream(operation, strategy);
  }

  private startManualQuestionGenerationStream(
    operation: ManualQuestionGenerationRead,
    strategy: QuestionGenerationStrategy,
  ): void {
    if (!this.isCurrentManualQuestionGeneration(operation)) {
      return;
    }
    this.clearManualQuestionGenerationStream();
    this.manualQuestionGenerationStreamSubscription = this.sse
      .streamJson<QuestionGenerationEvent>(
        `/projects/${encodeURIComponent(operation.project_id)}/sources/${encodeURIComponent(operation.source_id)}/question-generations/${encodeURIComponent(operation.id)}/events`,
        'question-generation',
        { isTerminal: isQuestionGenerationEventTerminal },
      )
      .subscribe({
        next: (event) => {
          if (!this.isCurrentManualQuestionGeneration(operation)) return;
          this.manualQuestionGeneration.set(event);
          this.manualQuestionGenerationStreamTerminalSeen ||= isQuestionGenerationEventTerminal(event);
          this.resetManualQuestionGenerationStreamError();
          if (event.status === 'succeeded') {
            this.clearManualQuestionGenerationStream();
            this.completeManualQuestionGeneration(event);
          } else if (event.status === 'failed') {
            this.clearManualQuestionGenerationStream();
            this.operations.fail(event.error ?? 'Question generation did not complete.');
            void this.openMissingAiRuntimePrompt(strategy, true);
          } else if (event.status === 'canceled') {
            this.clearManualQuestionGenerationStream();
          }
        },
        error: () => {
          this.manualQuestionGenerationStreamSubscription = null;
          this.manualQuestionGenerationStreamError.set(
            'Question generation progress could not be refreshed. Retry the event stream or cancel the operation.',
          );
        },
        complete: () => {
          if (this.manualQuestionGenerationStreamSubscription === null) return;
          this.manualQuestionGenerationStreamSubscription = null;
          if (!this.manualQuestionGenerationStreamTerminalSeen) {
            this.manualQuestionGenerationStreamError.set(
              'Question generation progress could not be refreshed. Retry the event stream or cancel the operation.',
            );
          }
        },
      });
  }

  private completeManualQuestionGeneration(
    operation: ManualQuestionGenerationRead,
  ): void {
    if (!this.isCurrentManualQuestionGeneration(operation)) {
      return;
    }
    this.load(operation.project_id);
    this.questionJobsStore.loadQuestionJobs(operation.project_id, operation.source_id).subscribe();
    this.sourceImport.refreshUploadedSource(operation.project_id, operation.source_id);
  }

  private isCurrentManualQuestionGeneration(
    operation: ManualQuestionGenerationRead,
  ): boolean {
    return (
      this.manualQuestionGeneration()?.id === operation.id &&
      this.projects.selectedProjectId() === operation.project_id &&
      this.sourceImport.activeSource()?.id === operation.source_id
    );
  }

  private clearManualQuestionGenerationStream(): void {
    this.manualQuestionGenerationStreamSubscription?.unsubscribe();
    this.manualQuestionGenerationStreamSubscription = null;
    this.manualQuestionGenerationStreamTerminalSeen = false;
  }

  private resetManualQuestionGenerationStreamError(): void {
    this.manualQuestionGenerationStreamError.set(null);
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }
    return 'Question generation operation failed.';
  }
}
