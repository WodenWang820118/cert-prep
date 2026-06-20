import { computed, effect, inject, Injectable, signal } from '@angular/core';
import {
  DraftGenerationJobRead,
  EXAM_PREP_API,
  QuestionDraftRead,
} from '../../exam-prep-api';
import type {
  DraftEdit,
  DraftJobSummary,
  DraftGenerationStrategy,
} from './contracts/draft-review.contracts';
import { DraftEditService } from './draft-edit.service';
import { HealthStore } from '../health/health.store';
import { OperationStore } from '../operation.store';
import { ProjectStore } from '../project.store';
import { SourceImportStore } from '../source-import/source-import.store';

const STREAMING_DRAFT_POLL_INTERVAL_MS = 1500;

@Injectable({ providedIn: 'root' })
export class DraftReviewStore {
  private readonly api = inject(EXAM_PREP_API);
  private readonly edits = inject(DraftEditService);
  private readonly health = inject(HealthStore);
  private readonly operations = inject(OperationStore);
  private readonly projects = inject(ProjectStore);
  private readonly sourceImport = inject(SourceImportStore);
  private streamingDraftPollKey: string | null = null;
  private streamingDraftPollTimer: ReturnType<typeof setTimeout> | null = null;

  readonly questionLimit = signal(3);
  readonly drafts = signal<QuestionDraftRead[]>([]);
  readonly draftJobs = signal<DraftGenerationJobRead[]>([]);
  readonly editingDraftId = signal<string | null>(null);
  readonly draftEdits = signal<Record<string, DraftEdit>>({});
  readonly playableQuestions = computed(() => this.drafts());
  readonly draftJobSummary = computed(() =>
    this.summarizeDraftJobs(this.draftJobs()),
  );
  readonly canRetryDraftJobs = computed(() => {
    const summary = this.draftJobSummary();
    return summary.skipped > 0 || summary.failed > 0;
  });

  constructor() {
    effect(() => {
      const projectId = this.projects.selectedProjectId();
      const document = this.sourceImport.uploadedDocument();
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
        this.ensureStreamingDraftPolling(projectId, document.id);
      } else if (documentKey === null) {
        this.stopStreamingDraftPolling({ clearJobs: true });
      } else {
        this.stopStreamingDraftPolling();
      }
    });
  }

  async load(projectId: string): Promise<void> {
    const drafts = await this.api.listQuestionDrafts(projectId);
    this.drafts.set(drafts.items);
  }

  reset(): void {
    this.drafts.set([]);
    this.draftJobs.set([]);
    this.editingDraftId.set(null);
    this.draftEdits.set({});
    this.stopStreamingDraftPolling();
  }

  setQuestionLimit(value: string | number): void {
    this.questionLimit.set(this.edits.clampQuestionLimit(value));
  }

  isEditing(draft: QuestionDraftRead): boolean {
    return this.editingDraftId() === draft.id;
  }

  draftEdit(draft: QuestionDraftRead): DraftEdit {
    return this.draftEdits()[draft.id] ?? this.edits.editFromDraft(draft);
  }

  startEdit(draft: QuestionDraftRead): void {
    this.draftEdits.update((edits) => ({
      ...edits,
      [draft.id]: this.edits.editFromDraft(draft),
    }));
    this.editingDraftId.set(draft.id);
  }

  cancelEdit(draft: QuestionDraftRead): void {
    this.removeDraftEdit(draft.id);
    if (this.editingDraftId() === draft.id) {
      this.editingDraftId.set(null);
    }
  }

  setEditQuestion(draftId: string, question: string): void {
    this.patchDraftEdit(draftId, (edit) => ({ ...edit, question }));
  }

  setEditChoice(draftId: string, index: number, choice: string): void {
    this.patchDraftEdit(draftId, (edit) => {
      const choices = [...edit.choices];
      choices[index] = choice;
      return { ...edit, choices };
    });
  }

  addEditChoice(draftId: string): void {
    this.patchDraftEdit(draftId, (edit) => ({
      ...edit,
      choices: [...edit.choices, ''],
    }));
  }

  removeEditChoice(draftId: string, index: number): void {
    this.patchDraftEdit(draftId, (edit) => {
      const choices = edit.choices.filter((_, choiceIndex) => choiceIndex !== index);
      const answer = choices.includes(edit.answer) ? edit.answer : '';
      return { ...edit, choices, answer };
    });
  }

  setEditAnswer(draftId: string, answer: string): void {
    this.patchDraftEdit(draftId, (edit) => ({ ...edit, answer }));
  }

  setEditRationale(draftId: string, rationale: string): void {
    this.patchDraftEdit(draftId, (edit) => ({ ...edit, rationale }));
  }

  async generateDrafts(
    strategy: DraftGenerationStrategy = 'hybrid_reasoning',
  ): Promise<void> {
    const project = this.projects.selectedProject();
    const document = this.sourceImport.uploadedDocument();
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
    await this.loadDraftJobs(project.id, document.id);
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
    const document = this.sourceImport.uploadedDocument();
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

    this.draftJobs.set(jobs.items);
    await this.load(project.id);
    await this.sourceImport.refreshUploadedDocument(project.id, document.id);
    if (this.hasActiveDraftJobs(jobs.items)) {
      this.ensureStreamingDraftPolling(project.id, document.id);
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

  private patchDraftEdit(
    draftId: string,
    updater: (edit: DraftEdit) => DraftEdit,
  ): void {
    const draft = this.drafts().find((candidate) => candidate.id === draftId);
    const current =
      this.draftEdits()[draftId] ??
      (draft ? this.edits.editFromDraft(draft) : null);
    if (current === null) {
      return;
    }
    this.draftEdits.update((edits) => ({
      ...edits,
      [draftId]: updater(current),
    }));
  }

  private removeDraftEdit(draftId: string): void {
    this.draftEdits.update((edits) => {
      const next = { ...edits };
      delete next[draftId];
      return next;
    });
  }

  private updatePayload(draft: QuestionDraftRead) {
    return this.edits.updatePayload(draft, this.draftEdit(draft));
  }

  private generatePayload(strategy: DraftGenerationStrategy) {
    return this.edits.generatePayload(this.questionLimit(), strategy);
  }

  private ensureStreamingDraftPolling(
    projectId: string,
    documentId: string,
  ): void {
    const nextKey = `${projectId}:${documentId}`;
    if (this.streamingDraftPollKey !== nextKey) {
      this.stopStreamingDraftPolling({ clearJobs: true });
      this.streamingDraftPollKey = nextKey;
      void this.pollStreamingDrafts(projectId, documentId);
      return;
    }

    if (this.streamingDraftPollTimer === null) {
      this.scheduleStreamingDraftPolling(projectId, documentId);
    }
  }

  private scheduleStreamingDraftPolling(
    projectId: string,
    documentId: string,
  ): void {
    this.streamingDraftPollTimer = setTimeout(() => {
      this.streamingDraftPollTimer = null;
      void this.pollStreamingDrafts(projectId, documentId);
    }, STREAMING_DRAFT_POLL_INTERVAL_MS);
  }

  private async pollStreamingDrafts(
    projectId: string,
    documentId: string,
  ): Promise<void> {
    if (this.streamingDraftPollKey !== `${projectId}:${documentId}`) {
      return;
    }

    try {
      await Promise.all([
        this.load(projectId),
        this.loadDraftJobs(projectId, documentId).catch(() => undefined),
      ]);
    } catch {
      this.stopStreamingDraftPolling();
      return;
    }

    const document = this.sourceImport.uploadedDocument();
    const selectedProjectId = this.projects.selectedProjectId();
    if (
      selectedProjectId === projectId &&
      document?.id === documentId &&
      (document.status === 'processing' || this.hasActiveDraftJobs(this.draftJobs()))
    ) {
      this.scheduleStreamingDraftPolling(projectId, documentId);
    } else {
      this.stopStreamingDraftPolling();
    }
  }

  private stopStreamingDraftPolling(
    options: { clearJobs?: boolean } = {},
  ): void {
    if (this.streamingDraftPollTimer !== null) {
      clearTimeout(this.streamingDraftPollTimer);
      this.streamingDraftPollTimer = null;
    }
    this.streamingDraftPollKey = null;
    if (options.clearJobs) {
      this.draftJobs.set([]);
    }
  }

  private async loadDraftJobs(
    projectId: string,
    documentId: string,
  ): Promise<void> {
    const jobs = await this.api.listDocumentDraftJobs(projectId, documentId);
    this.draftJobs.set(jobs.items);
  }

  private hasActiveDraftJobs(jobs: DraftGenerationJobRead[]): boolean {
    return jobs.some((job) => ['pending', 'running'].includes(job.status));
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
