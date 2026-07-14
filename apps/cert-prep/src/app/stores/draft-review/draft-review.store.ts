import { computed, effect, inject, Injectable, signal } from '@angular/core';
import {
  CERT_PREP_API,
  type ManualDraftGenerationOperationRead,
  QuestionDraftRead,
} from '../../cert-prep-api';
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

const MANUAL_DRAFT_POLL_INTERVAL_MS = 1500;
const MANUAL_DRAFT_POLL_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

@Injectable({ providedIn: 'root' })
export class DraftReviewStore {
  private readonly api = inject(CERT_PREP_API);
  private readonly edits = inject(DraftEditService);
  private readonly editSession = inject(DraftEditSessionStore);
  private readonly health = inject(HealthStore);
  private readonly operations = inject(OperationStore);
  private readonly playability = inject(DraftPlayabilityService);
  private readonly projects = inject(ProjectStore);
  private readonly sourceImport = inject(SourceImportStore);
  private readonly streamingJobs = inject(DraftStreamingJobsStore);
  private manualDraftPollTimer: ReturnType<typeof setTimeout> | null = null;
  private manualDraftPollFailureCount = 0;

  readonly questionLimit = signal(3);
  readonly drafts = signal<QuestionDraftRead[]>([]);
  readonly draftJobs = this.streamingJobs.draftJobs;
  readonly manualDraftOperation = signal<ManualDraftGenerationOperationRead | null>(
    null,
  );
  readonly manualDraftCanceling = signal(false);
  readonly manualDraftPollingError = signal<string | null>(null);
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
  readonly pollingError = this.streamingJobs.pollingError;
  readonly isManualDraftOperationActive = computed(() => {
    const status = this.manualDraftOperation()?.status;
    return ['queued', 'running', 'cancel_requested'].includes(status ?? '');
  });
  readonly isManualDraftProgressActive = computed(
    () =>
      this.isManualDraftOperationActive() &&
      this.manualDraftPollingError() === null,
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

  constructor() {
    effect(() => {
      const projectId = this.projects.selectedProjectId();
      const document = this.sourceImport.activeDocument();
      const operation = this.manualDraftOperation();
      if (
        operation !== null &&
        (operation.project_id !== projectId || operation.document_id !== document?.id)
      ) {
        this.clearManualDraftPollTimer();
        this.manualDraftOperation.set(null);
        this.resetManualDraftPollingFailure();
      }
      this.streamingJobs.syncPolling(projectId, document, (id) =>
        this.load(id),
      );
    });
  }

  async load(projectId: string): Promise<void> {
    const drafts = await this.api.listQuestionDrafts(projectId);
    if (this.projects.selectedProjectId() !== projectId) {
      return;
    }

    this.drafts.set(drafts.items);
  }

  reset(): void {
    this.drafts.set([]);
    this.editSession.reset();
    this.streamingJobs.reset();
    this.clearManualDraftPollTimer();
    this.manualDraftOperation.set(null);
    this.resetManualDraftPollingFailure();
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

  async generateDrafts(
    strategy: DraftGenerationStrategy = 'hybrid_reasoning',
  ): Promise<void> {
    const project = this.projects.selectedProject();
    const document = this.sourceImport.activeDocument();
    if (project === null || document === null) {
      this.operations.fail('Upload a text PDF before generating questions.');
      return;
    }

    if (this.isManualDraftOperationActive()) {
      return;
    }

    const operation = await this.operations.run(
      'questions',
      strategy === 'deterministic_only'
        ? 'Deterministic question generation queued'
        : 'Reasoning question generation queued',
      () =>
        this.api.startManualDraftOperation(
          project.id,
          document.id,
          this.generatePayload(strategy),
        ),
    );
    if (operation === null) {
      await this.openMissingAiRuntimePrompt(strategy);
      return;
    }

    this.manualDraftOperation.set(operation);
    this.resetManualDraftPollingFailure();
    this.continueManualDraftOperation(operation, strategy);
  }

  async cancelManualDraftOperation(): Promise<void> {
    const operation = this.manualDraftOperation();
    if (operation === null || !this.canCancelManualDraftOperation()) {
      return;
    }
    this.manualDraftCanceling.set(true);
    try {
      const canceled = await this.api.cancelManualDraftOperation(
        operation.project_id,
        operation.document_id,
        operation.id,
      );
      if (!this.isCurrentManualDraftOperation(operation)) {
        return;
      }
      this.manualDraftOperation.set(canceled);
      this.continueManualDraftOperation(
        canceled,
        operation.strategy as DraftGenerationStrategy,
      );
    } catch (error) {
      this.operations.fail(this.errorMessage(error));
    } finally {
      this.manualDraftCanceling.set(false);
    }
  }

  async cancelActiveDraftJobs(): Promise<void> {
    await this.streamingJobs.cancelActiveDraftJobs();
  }

  retryManualDraftPolling(): void {
    const operation = this.manualDraftOperation();
    if (operation === null || !this.isManualDraftOperationActive()) {
      return;
    }
    this.clearManualDraftPollTimer();
    this.resetManualDraftPollingFailure();
    void this.refreshManualDraftOperation(
      operation,
      operation.strategy as DraftGenerationStrategy,
    );
  }

  private async openMissingAiRuntimePrompt(
    strategy: DraftGenerationStrategy,
    providerUnavailable = false,
  ): Promise<void> {
    if (
      strategy !== 'hybrid_reasoning' ||
      (!providerUnavailable &&
        this.operations.errorCode() !== 'provider_unavailable')
    ) {
      return;
    }

    try {
      await this.health.load();
    } catch {
      return;
    }

    if (this.health.canInstallOllama()) {
      this.health.openOllamaInstallConsent();
      return;
    }

    if (this.health.canDownloadModel()) {
      this.health.openModelDownloadConsent();
    }
  }

  async retryDraftJobs(): Promise<void> {
    const project = this.projects.selectedProject();
    const document = this.sourceImport.activeDocument();
    if (project === null || document === null) {
      this.operations.fail('Select a parsed document before retrying question generation.');
      return;
    }

    const jobs = await this.operations.run(
      'questions',
      'Question generation retry queued',
      () => this.api.retryDocumentDraftJobs(project.id, document.id),
    );
    if (jobs === null) {
      return;
    }

    this.streamingJobs.setDraftJobs(jobs.items);
    await this.load(project.id);
    await this.sourceImport.refreshUploadedDocument(project.id, document.id);
    if (this.streamingJobs.hasActiveDraftJobs(jobs.items)) {
      this.streamingJobs.ensurePolling(project.id, document.id, (id) =>
        this.load(id),
      );
    }
  }

  retryDraftPolling(): void {
    const project = this.projects.selectedProject();
    const document = this.sourceImport.activeDocument();
    if (project === null || document === null) {
      return;
    }

    this.streamingJobs.retryPolling(project.id, document.id, (projectId) =>
      this.load(projectId),
    );
  }

  async saveDraft(draft: QuestionDraftRead): Promise<QuestionDraftRead | null> {
    const project = this.projects.selectedProject();
    if (project === null) {
      this.operations.fail('Select a project before saving questions.');
      return null;
    }

    const updated = await this.operations.run('saveDraft', 'Question saved', () =>
      this.api.updateQuestionDraft(project.id, draft.id, this.updatePayload(draft)),
    );
    if (updated !== null) {
      this.upsertDraft(updated);
      this.cancelEdit(updated);
    }
    return updated;
  }

  private upsertDraft(nextDraft: QuestionDraftRead): void {
    this.drafts.update((drafts) => {
      const existingIndex = drafts.findIndex(
        (draft) => draft.id === nextDraft.id,
      );
      if (existingIndex === -1) {
        return [nextDraft, ...drafts];
      }

      return drafts.map((draft, index) =>
        index === existingIndex ? nextDraft : draft,
      );
    });
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
    this.clearManualDraftPollTimer();
    if (operation.status === 'succeeded') {
      void this.completeManualDraftOperation(operation);
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
    this.manualDraftPollTimer = setTimeout(() => {
      this.manualDraftPollTimer = null;
      void this.refreshManualDraftOperation(operation, strategy);
    }, MANUAL_DRAFT_POLL_INTERVAL_MS);
  }

  private async refreshManualDraftOperation(
    operation: ManualDraftGenerationOperationRead,
    strategy: DraftGenerationStrategy,
  ): Promise<void> {
    if (!this.isCurrentManualDraftOperation(operation)) {
      return;
    }
    try {
      const refreshed = await this.api.getManualDraftOperation(
        operation.project_id,
        operation.document_id,
        operation.id,
      );
      if (!this.isCurrentManualDraftOperation(operation)) {
        return;
      }
      this.manualDraftOperation.set(refreshed);
      this.resetManualDraftPollingFailure();
      this.continueManualDraftOperation(refreshed, strategy);
    } catch {
      const delay =
        MANUAL_DRAFT_POLL_RETRY_DELAYS_MS[this.manualDraftPollFailureCount];
      if (delay === undefined) {
        this.clearManualDraftPollTimer();
        this.manualDraftPollingError.set(
          'Question generation progress could not be refreshed. Retry the status check or cancel the operation.',
        );
        return;
      }
      this.manualDraftPollFailureCount += 1;
      this.manualDraftPollTimer = setTimeout(() => {
        this.manualDraftPollTimer = null;
        void this.refreshManualDraftOperation(operation, strategy);
      }, delay);
    }
  }

  private async completeManualDraftOperation(
    operation: ManualDraftGenerationOperationRead,
  ): Promise<void> {
    if (!this.isCurrentManualDraftOperation(operation)) {
      return;
    }
    await Promise.all([
      this.load(operation.project_id),
      this.streamingJobs.loadDraftJobs(
        operation.project_id,
        operation.document_id,
      ),
      this.sourceImport.refreshUploadedDocument(
        operation.project_id,
        operation.document_id,
      ),
    ]);
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

  private clearManualDraftPollTimer(): void {
    if (this.manualDraftPollTimer !== null) {
      clearTimeout(this.manualDraftPollTimer);
      this.manualDraftPollTimer = null;
    }
  }

  private resetManualDraftPollingFailure(): void {
    this.manualDraftPollFailureCount = 0;
    this.manualDraftPollingError.set(null);
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }
    return 'Question generation operation failed.';
  }
}
