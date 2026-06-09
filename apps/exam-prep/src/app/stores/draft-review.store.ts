import { computed, inject, Injectable, signal } from '@angular/core';
import { EXAM_PREP_API, QuestionDraftRead } from '../exam-prep-api';
import { OperationStore } from './operation.store';
import { ProjectStore } from './project.store';
import { SourceImportStore } from './source-import.store';

@Injectable({ providedIn: 'root' })
export class DraftReviewStore {
  private readonly api = inject(EXAM_PREP_API);
  private readonly operations = inject(OperationStore);
  private readonly projects = inject(ProjectStore);
  private readonly sourceImport = inject(SourceImportStore);

  readonly draftLimit = signal(3);
  readonly drafts = signal<QuestionDraftRead[]>([]);
  readonly approvedDrafts = computed(() =>
    this.drafts().filter((draft) => draft.status === 'approved'),
  );

  async load(projectId: string): Promise<void> {
    const drafts = await this.api.listQuestionDrafts(projectId);
    this.drafts.set(drafts.items);
  }

  reset(): void {
    this.drafts.set([]);
  }

  setDraftLimit(value: string | number): void {
    this.draftLimit.set(clampInteger(value, 1, 50));
  }

  canApprove(draft: QuestionDraftRead): boolean {
    return (
      draft.status !== 'approved' &&
      draft.document_id !== null &&
      draft.chunk_id !== null &&
      draft.citation_page !== null &&
      draft.citation_page > 0 &&
      hasText(draft.source_excerpt) &&
      draft.choices.length >= 2 &&
      hasText(draft.answer) &&
      draft.choices.includes(draft.answer) &&
      hasText(draft.rationale)
    );
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
      return;
    }

    this.drafts.set(drafts.items);
    await this.load(project.id);
  }

  async approveDraft(draft: QuestionDraftRead): Promise<void> {
    const project = this.projects.selectedProject();
    if (project === null) {
      this.operations.fail('Select a project before approving drafts.');
      return;
    }

    if (!this.canApprove(draft)) {
      this.operations.fail(
        'Draft needs a citation, source excerpt, choices, answer, and rationale before approval.',
      );
      return;
    }

    const approved = await this.operations.run('approve', 'Draft approved', () =>
      this.api.approveQuestionDraft(project.id, draft.id),
    );
    if (approved !== null) {
      this.upsertDraft(approved);
    }
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
