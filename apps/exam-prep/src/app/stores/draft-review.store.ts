import { computed, inject, Injectable, signal } from '@angular/core';
import {
  EXAM_PREP_API,
  QuestionDraftRead,
  QuestionDraftUpdate,
} from '../exam-prep-api';
import { HealthStore } from './health.store';
import { OperationStore } from './operation.store';
import { ProjectStore } from './project.store';
import { SourceImportStore } from './source-import.store';

@Injectable({ providedIn: 'root' })
export class DraftReviewStore {
  private readonly api = inject(EXAM_PREP_API);
  private readonly health = inject(HealthStore);
  private readonly operations = inject(OperationStore);
  private readonly projects = inject(ProjectStore);
  private readonly sourceImport = inject(SourceImportStore);

  readonly draftLimit = signal(3);
  readonly drafts = signal<QuestionDraftRead[]>([]);
  readonly editingDraftId = signal<string | null>(null);
  readonly draftEdits = signal<Record<string, DraftEdit>>({});
  readonly approvedDrafts = computed(() =>
    this.drafts().filter((draft) => draft.status === 'approved'),
  );

  async load(projectId: string): Promise<void> {
    const drafts = await this.api.listQuestionDrafts(projectId);
    this.drafts.set(drafts.items);
  }

  reset(): void {
    this.drafts.set([]);
    this.editingDraftId.set(null);
    this.draftEdits.set({});
  }

  setDraftLimit(value: string | number): void {
    this.draftLimit.set(clampInteger(value, 1, 50));
  }

  canApprove(draft: QuestionDraftRead): boolean {
    return draft.status !== 'approved' && this.approvalBlockers(draft).length === 0;
  }

  isEditing(draft: QuestionDraftRead): boolean {
    return this.editingDraftId() === draft.id;
  }

  draftEdit(draft: QuestionDraftRead): DraftEdit {
    return this.draftEdits()[draft.id] ?? editFromDraft(draft);
  }

  startEdit(draft: QuestionDraftRead): void {
    this.draftEdits.update((edits) => ({
      ...edits,
      [draft.id]: editFromDraft(draft),
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

  approvalBlockers(draft: QuestionDraftRead): string[] {
    const edit = this.draftEdit(draft);
    const choices = normalizeChoices(edit.choices);
    const answer = edit.answer.trim();
    const blockers: string[] = [];

    if (
      draft.document_id === null ||
      draft.chunk_id === null ||
      draft.citation_page === null ||
      draft.citation_page <= 0
    ) {
      blockers.push('missing citation');
    }
    if (!hasText(draft.source_excerpt)) {
      blockers.push('missing source excerpt');
    }
    if (!hasText(answer)) {
      blockers.push('missing answer');
    } else if (!choices.includes(answer)) {
      blockers.push('choice mismatch');
    }
    if (choices.length < 2) {
      blockers.push('choice mismatch');
    }
    if (!hasText(edit.rationale)) {
      blockers.push('missing rationale');
    }

    return Array.from(new Set(blockers));
  }

  approvalBlockerText(draft: QuestionDraftRead): string {
    const blockers = this.approvalBlockers(draft);
    return blockers.length === 0 ? 'Ready to approve' : blockers.join(', ');
  }

  async generateDrafts(): Promise<void> {
    const project = this.projects.selectedProject();
    const document = this.sourceImport.uploadedDocument();
    if (project === null || document === null) {
      this.operations.fail('Upload a text PDF before generating drafts.');
      return;
    }

    const drafts = await this.operations.run(
      'drafts',
      'Cited drafts generated',
      () =>
        this.api.generateDocumentDrafts(project.id, document.id, {
          limit: this.draftLimit(),
        }),
    );
    if (drafts === null) {
      await this.openMissingAiRuntimePrompt();
      return;
    }

    this.drafts.set(drafts.items);
    await this.load(project.id);
    await this.sourceImport.refreshUploadedDocument(project.id, document.id);
  }

  private async openMissingAiRuntimePrompt(): Promise<void> {
    if (this.operations.errorCode() !== 'provider_unavailable') {
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

  async approveDraft(draft: QuestionDraftRead): Promise<void> {
    const project = this.projects.selectedProject();
    if (project === null) {
      this.operations.fail('Select a project before approving drafts.');
      return;
    }

    if (!this.canApprove(draft)) {
      this.operations.fail(`Draft cannot be approved: ${this.approvalBlockerText(draft)}.`);
      return;
    }

    const approved = await this.operations.run('approve', 'Draft approved', () =>
      this.api.approveQuestionDraft(project.id, draft.id),
    );
    if (approved !== null) {
      this.upsertDraft(approved);
      this.cancelEdit(approved);
    }
  }

  async saveDraft(draft: QuestionDraftRead): Promise<QuestionDraftRead | null> {
    const project = this.projects.selectedProject();
    if (project === null) {
      this.operations.fail('Select a project before saving drafts.');
      return null;
    }

    const updated = await this.operations.run('saveDraft', 'Draft saved', () =>
      this.api.updateQuestionDraft(project.id, draft.id, this.updatePayload(draft)),
    );
    if (updated !== null) {
      this.upsertDraft(updated);
      this.startEdit(updated);
    }
    return updated;
  }

  async saveAndApproveDraft(draft: QuestionDraftRead): Promise<void> {
    const saved = await this.saveDraft(draft);
    if (saved === null) {
      return;
    }
    await this.approveDraft(saved);
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
    const current = this.draftEdits()[draftId] ?? (draft ? editFromDraft(draft) : null);
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

  private updatePayload(draft: QuestionDraftRead): QuestionDraftUpdate {
    const edit = this.draftEdit(draft);
    const choices = normalizeChoices(edit.choices);
    const answer = edit.answer.trim();
    return {
      question: edit.question.trim(),
      choices,
      answer: answer.length > 0 ? answer : null,
      answer_key_source: 'manual',
      rationale: emptyToNull(edit.rationale),
      citation_page: draft.citation_page,
      source_excerpt: draft.source_excerpt,
    };
  }
}

interface DraftEdit {
  question: string;
  choices: string[];
  answer: string;
  rationale: string;
}

function clampInteger(
  value: string | number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return minimum;
  }

  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function hasText(value: string | null): value is string {
  return value !== null && value.trim().length > 0;
}

function editFromDraft(draft: QuestionDraftRead): DraftEdit {
  return {
    question: draft.question,
    choices: draft.choices.length > 0 ? [...draft.choices] : ['', ''],
    answer: draft.answer ?? '',
    rationale: draft.rationale ?? '',
  };
}

function normalizeChoices(choices: string[]): string[] {
  return choices.map((choice) => choice.trim()).filter((choice) => choice.length > 0);
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
