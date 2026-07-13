import { computed, effect, inject, Injectable, signal } from '@angular/core';
import {
  CERT_PREP_API,
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

  readonly questionLimit = signal(3);
  readonly drafts = signal<QuestionDraftRead[]>([]);
  readonly draftJobs = this.streamingJobs.draftJobs;
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

  constructor() {
    effect(() => {
      const projectId = this.projects.selectedProjectId();
      const document = this.sourceImport.activeDocument();
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

    const drafts = await this.operations.run(
      'questions',
      strategy === 'deterministic_only'
        ? 'Deterministic questions generated'
        : 'Reasoning questions generated',
      () =>
        this.api.generateDocumentDrafts(
          project.id,
          document.id,
          this.generatePayload(strategy),
        ),
    );
    if (drafts === null) {
      await this.openMissingAiRuntimePrompt(strategy);
      return;
    }

    this.drafts.set(drafts.items);
    await this.load(project.id);
    await this.streamingJobs.loadDraftJobs(project.id, document.id);
    await this.sourceImport.refreshUploadedDocument(project.id, document.id);
  }

  private async openMissingAiRuntimePrompt(
    strategy: DraftGenerationStrategy,
  ): Promise<void> {
    if (
      strategy !== 'hybrid_reasoning' ||
      this.operations.errorCode() !== 'provider_unavailable'
    ) {
      return;
    }

    try {
      if (!(await this.health.load())) {
        return;
      }
    } catch {
      return;
    }

    if (this.health.canReviewFastFlowTerms()) {
      await this.health.openFastFlowTermsConsent();
      return;
    }

    if (this.health.canInstallFastFlow()) {
      this.health.openFastFlowInstallConsent();
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
}
