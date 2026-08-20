import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { from, Subscription } from 'rxjs';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import type {
  ManualDraftGenerationOperationRead,
  QuestionDraftRead,
} from '../../contracts/api.contracts';
import { isDraftOperationEventTerminal } from '../../contracts/operation-events.contracts';
import type { DraftOperationEvent } from '../../contracts/operation-events.contracts';
import { CertPrepHttpResourceClient } from '../../services/cert-prep-http-resource-client.service';
import { CertPrepSseClient } from '../../services/cert-prep-sse-client.service';
import type {
  DraftEdit,
  DraftGenerationStrategy,
} from './contracts/draft-review.contracts';
import { DraftEditService } from './draft-edit.service';
import { DraftEditSessionStore } from './draft-edit-session.store';
import { DraftPlayabilityService } from './draft-playability.service';
import { DraftStreamingJobsStore } from './draft-streaming-jobs.store';
import { HealthStore } from '../health/health.store';
import { OperationStore } from '../operation.store';
import { ProjectStore } from '../project.store';
import { SourceImportStore } from '../source-import/source-import.store';

@Injectable({ providedIn: 'root' })
export class DraftReviewStore {
  private readonly api = inject(CERT_PREP_API);
  private readonly edits = inject(DraftEditService);
  private readonly editSession = inject(DraftEditSessionStore);
  private readonly health = inject(HealthStore);
  private readonly operations = inject(OperationStore);
  private readonly playability = inject(DraftPlayabilityService);
  private readonly projects = inject(ProjectStore);
  private readonly resources = inject(CertPrepHttpResourceClient);
  private readonly sse = inject(CertPrepSseClient);
  private readonly sourceImport = inject(SourceImportStore);
  private readonly streamingJobs = inject(DraftStreamingJobsStore);
  private readonly draftsQueryEnabled = signal(false);
  private manualDraftStreamSubscription: Subscription | null = null;
  private manualDraftStreamTerminalSeen = false;

  readonly questionLimit = signal(3);
  private readonly draftsResource = this.resources.questionDrafts(() =>
    this.draftsQueryEnabled() ? this.projects.selectedProjectId() : null,
  );
  readonly drafts = signal<QuestionDraftRead[]>([]);
  readonly draftsLoading = this.draftsResource.isLoading;
  readonly draftsError = this.draftsResource.error;
  readonly draftJobs = this.streamingJobs.draftJobs;
  readonly manualDraftOperation = signal<ManualDraftGenerationOperationRead | null>(
    null,
  );
  readonly manualDraftCanceling = signal(false);
  readonly manualDraftStreamError = signal<string | null>(null);
  readonly editingDraftId = this.editSession.editingDraftId;
  readonly draftEdits = this.editSession.draftEdits;
  readonly playableQuestions = computed(() =>
    this.drafts().filter((draft) => this.isPlayableDraft(draft)),
  );
  readonly activeDocumentDrafts = computed(() => {
    const documentId = this.sourceImport.activeDocumentId();
    return documentId === null
      ? this.drafts()
      : this.drafts().filter((draft) => draft.document_id === documentId);
  });
  readonly activeDocumentPlayableQuestions = computed(() =>
    this.activeDocumentDrafts().filter((draft) => this.isPlayableDraft(draft)),
  );
  readonly draftJobSummary = this.streamingJobs.draftJobSummary;
  readonly canRetryDraftJobs = this.streamingJobs.canRetryDraftJobs;
  readonly canCancelActiveDraftJobs =
    this.streamingJobs.canCancelActiveDraftJobs;
  readonly cancelingDraftJobs = this.streamingJobs.cancelingDraftJobs;
  readonly streamError = this.streamingJobs.streamError;
  readonly isManualDraftOperationActive = computed(() => {
    const status = this.manualDraftOperation()?.status;
    return ['queued', 'running', 'cancel_requested'].includes(status ?? '');
  });
  readonly isManualDraftProgressActive = computed(
    () =>
      this.isManualDraftOperationActive() &&
       this.manualDraftStreamError() === null,
  );
  readonly canCancelManualDraftOperation = computed(() => {
    const operation = this.manualDraftOperation();
    return (
      operation !== null &&
      operation.cancellable &&
      ['queued', 'running', 'cancel_requested'].includes(operation.status) &&
      !this.manualDraftCanceling()
    );
  });
  private readonly draftResourceSync = effect(() => {
    const draftResourceStatus = this.draftsResource.status();
    if (draftResourceStatus === 'resolved' || draftResourceStatus === 'local') {
      this.drafts.set(this.draftsResource.value());
    }
  });

  constructor() {
    effect(() => {
      const projectId = this.projects.selectedProjectId();
      const document = this.sourceImport.activeDocument();
      const operation = this.manualDraftOperation();
      if (
        operation !== null &&
        (operation.project_id !== projectId || operation.document_id !== document?.id)
      ) {
         this.clearManualDraftStream();
         this.manualDraftOperation.set(null);
         this.resetManualDraftStreamError();
       }
       this.streamingJobs.syncStreaming(projectId, document, (id) => {
        this.load(id);
      });
    });
  }

  load(projectId: string): void {
    if (this.projects.selectedProjectId() !== projectId) {
      return;
    }
    if (!this.draftsQueryEnabled()) {
      this.draftsQueryEnabled.set(true);
      return;
    }
    this.draftsResource.reload();
  }

  reset(): void {
    this.drafts.set([]);
    this.draftsResource.set([]);
    this.editSession.reset();
    this.streamingJobs.reset();
    this.clearManualDraftStream();
    this.manualDraftOperation.set(null);
    this.resetManualDraftStreamError();
  }

  setQuestionLimit(value: string | number): void {
    this.questionLimit.set(this.edits.clampQuestionLimit(value));
  }

  isEditing(draft: QuestionDraftRead): boolean {
    return this.editSession.isEditing(draft);
  }

  isPlayableDraft(draft: QuestionDraftRead): boolean {
    return this.playability.isPlayableDraft(draft);
  }

  draftStatusLabel(draft: QuestionDraftRead): string {
    return this.playability.statusLabel(draft);
  }

  draftEdit(draft: QuestionDraftRead): DraftEdit {
    return this.editSession.draftEdit(draft);
  }

  startEdit(draft: QuestionDraftRead): void {
    this.editSession.startEdit(draft);
  }

  cancelEdit(draft: QuestionDraftRead): void {
    this.editSession.cancelEdit(draft);
  }

  setEditQuestion(draftId: string, question: string): void {
    this.editSession.setEditQuestion(draftId, this.drafts(), question);
  }

  setEditChoice(draftId: string, index: number, choice: string): void {
    this.editSession.setEditChoice(draftId, this.drafts(), index, choice);
  }

  addEditChoice(draftId: string): void {
    this.editSession.addEditChoice(draftId, this.drafts());
  }

  removeEditChoice(draftId: string, index: number): void {
    this.editSession.removeEditChoice(draftId, this.drafts(), index);
  }

  setEditAnswer(draftId: string, answer: string): void {
    this.editSession.setEditAnswer(draftId, this.drafts(), answer);
  }

  setEditRationale(draftId: string, rationale: string): void {
    this.editSession.setEditRationale(draftId, this.drafts(), rationale);
  }

  generateDrafts(
    strategy: DraftGenerationStrategy = 'hybrid_reasoning',
  ): void {
    const project = this.projects.selectedProject();
    const document = this.sourceImport.activeDocument();
    if (project === null || document === null) {
      this.operations.fail(
        'Upload a source file with extractable text before generating questions.',
      );
      return;
    }

    if (this.isManualDraftOperationActive()) {
      return;
    }

    this.operations
      .run(
        'questions',
        strategy === 'deterministic_only'
          ? 'Deterministic question generation queued'
          : 'Reasoning question generation queued',
        (signal) =>
          from(this.api.startManualDraftOperation(
            project.id,
            document.id,
            this.generatePayload(strategy),
            { signal },
          )),
      )
      .subscribe((operation) => {
        if (operation === null) {
          this.openMissingAiRuntimePrompt(strategy);
          return;
        }
        this.manualDraftOperation.set(operation);
         this.resetManualDraftStreamError();
         this.continueManualDraftOperation(operation, strategy);
      });
  }

  cancelManualDraftOperation(): void {
    const operation = this.manualDraftOperation();
    if (operation === null || !this.canCancelManualDraftOperation()) {
      return;
    }
    this.manualDraftCanceling.set(true);
    from(this.api
      .cancelManualDraftOperation(
        operation.project_id,
        operation.document_id,
        operation.id,
      ))
      .subscribe({
        next: (canceled) => {
          if (!this.isCurrentManualDraftOperation(operation)) return;
          this.manualDraftOperation.set(canceled);
          this.continueManualDraftOperation(canceled, operation.strategy as DraftGenerationStrategy);
          this.manualDraftCanceling.set(false);
        },
        error: (error: unknown) => {
          this.operations.fail(this.errorMessage(error));
          this.manualDraftCanceling.set(false);
        },
      });
  }

  cancelActiveDraftJobs(): void {
    this.streamingJobs.cancelActiveDraftJobs();
  }

  retryManualDraftStream(): void {
    const operation = this.manualDraftOperation();
    if (operation === null || !this.isManualDraftOperationActive()) {
      return;
    }
    this.clearManualDraftStream();
    this.resetManualDraftStreamError();
    this.startManualDraftStream(operation, operation.strategy as DraftGenerationStrategy);
  }

  private openMissingAiRuntimePrompt(
    strategy: DraftGenerationStrategy,
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

  retryDraftJobs(): void {
    const project = this.projects.selectedProject();
    const document = this.sourceImport.activeDocument();
    if (project === null || document === null) {
      this.operations.fail('Select a parsed document before retrying question generation.');
      return;
    }

    this.operations
      .run('questions', 'Question generation retry queued', (signal) =>
        from(this.api.retryDocumentDraftJobs(project.id, document.id, { signal })),
      )
      .subscribe((jobs) => {
        if (jobs === null) return;
        this.streamingJobs.setDraftJobs(jobs.items);
        this.load(project.id);
        this.sourceImport.refreshUploadedDocument(project.id, document.id);
        if (this.streamingJobs.hasActiveDraftJobs(jobs.items)) {
          this.streamingJobs.ensureStreaming(project.id, document.id, (id) => this.load(id));
        }
      });
  }

  retryDraftStream(): void {
    const project = this.projects.selectedProject();
    const document = this.sourceImport.activeDocument();
    if (project === null || document === null) {
      return;
    }

    this.streamingJobs.retryStreaming(project.id, document.id, (projectId) => {
      this.load(projectId);
    });
  }

  saveDraft(draft: QuestionDraftRead): void {
    const project = this.projects.selectedProject();
    if (project === null) {
      this.operations.fail('Select a project before saving questions.');
      return;
    }

    this.operations
      .run('saveDraft', 'Question saved', (signal) =>
        from(this.api.updateQuestionDraft(project.id, draft.id, this.updatePayload(draft), { signal })),
      )
      .subscribe((updated) => {
        if (updated === null) return;
        this.upsertDraft(updated);
        this.cancelEdit(updated);
      });
  }

  private upsertDraft(nextDraft: QuestionDraftRead): void {
    const nextDrafts = (() => {
      const drafts = this.drafts();
      const existingIndex = drafts.findIndex(
        (draft) => draft.id === nextDraft.id,
      );
      if (existingIndex === -1) {
        return [nextDraft, ...drafts];
      }

      return drafts.map((draft, index) =>
        index === existingIndex ? nextDraft : draft,
      );
    })();
    this.drafts.set(nextDrafts);
    this.draftsResource.set(nextDrafts);
  }

  private updatePayload(draft: QuestionDraftRead) {
    return this.editSession.updatePayload(draft);
  }

  private generatePayload(strategy: DraftGenerationStrategy) {
    return this.edits.generatePayload(this.questionLimit(), strategy);
  }

  private continueManualDraftOperation(
    operation: ManualDraftGenerationOperationRead,
    strategy: DraftGenerationStrategy,
  ): void {
    if (operation.status === 'succeeded') {
      this.completeManualDraftOperation(operation);
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
    this.startManualDraftStream(operation, strategy);
  }

  private startManualDraftStream(
    operation: ManualDraftGenerationOperationRead,
    strategy: DraftGenerationStrategy,
  ): void {
    if (!this.isCurrentManualDraftOperation(operation)) {
      return;
    }
    this.clearManualDraftStream();
    this.manualDraftStreamSubscription = this.sse
      .streamJson<DraftOperationEvent>(
        `/projects/${encodeURIComponent(operation.project_id)}/documents/${encodeURIComponent(operation.document_id)}/draft-operations/${encodeURIComponent(operation.id)}/events`,
        'draft-operation',
        { isTerminal: isDraftOperationEventTerminal },
      )
      .subscribe({
        next: (event) => {
          if (!this.isCurrentManualDraftOperation(operation)) return;
          this.manualDraftOperation.set(event);
          this.manualDraftStreamTerminalSeen ||= isDraftOperationEventTerminal(event);
          this.resetManualDraftStreamError();
          if (event.status === 'succeeded') {
            this.clearManualDraftStream();
            this.completeManualDraftOperation(event);
          } else if (event.status === 'failed') {
            this.clearManualDraftStream();
            this.operations.fail(event.error ?? 'Question generation did not complete.');
            void this.openMissingAiRuntimePrompt(strategy, true);
          } else if (event.status === 'canceled') {
            this.clearManualDraftStream();
          }
        },
        error: () => {
          this.manualDraftStreamSubscription = null;
          this.manualDraftStreamError.set(
            'Question generation progress could not be refreshed. Retry the event stream or cancel the operation.',
          );
        },
        complete: () => {
          if (this.manualDraftStreamSubscription === null) return;
          this.manualDraftStreamSubscription = null;
          if (!this.manualDraftStreamTerminalSeen) {
            this.manualDraftStreamError.set(
              'Question generation progress could not be refreshed. Retry the event stream or cancel the operation.',
            );
          }
        },
      });
  }

  private completeManualDraftOperation(
    operation: ManualDraftGenerationOperationRead,
  ): void {
    if (!this.isCurrentManualDraftOperation(operation)) {
      return;
    }
    this.load(operation.project_id);
    this.streamingJobs.loadDraftJobs(operation.project_id, operation.document_id).subscribe();
    this.sourceImport.refreshUploadedDocument(operation.project_id, operation.document_id);
  }

  private isCurrentManualDraftOperation(
    operation: ManualDraftGenerationOperationRead,
  ): boolean {
    return (
      this.manualDraftOperation()?.id === operation.id &&
      this.projects.selectedProjectId() === operation.project_id &&
      this.sourceImport.activeDocument()?.id === operation.document_id
    );
  }

  private clearManualDraftStream(): void {
    this.manualDraftStreamSubscription?.unsubscribe();
    this.manualDraftStreamSubscription = null;
    this.manualDraftStreamTerminalSeen = false;
  }

  private resetManualDraftStreamError(): void {
    this.manualDraftStreamError.set(null);
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }
    return 'Question generation operation failed.';
  }
}
