import { inject, Injectable, signal } from '@angular/core';
import type { QuestionDraftRead } from '../../cert-prep-api';
import type {
  DraftEdit,
  DraftGenerationStrategy,
} from './contracts/draft-review.contracts';
import { DraftEditService } from './draft-edit.service';

@Injectable({ providedIn: 'root' })
export class DraftEditSessionStore {
  private readonly edits = inject(DraftEditService);

  readonly editingDraftId = signal<string | null>(null);
  readonly draftEdits = signal<Record<string, DraftEdit>>({});

  reset(): void {
    this.editingDraftId.set(null);
    this.draftEdits.set({});
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

  setEditQuestion(
    draftId: string,
    drafts: readonly QuestionDraftRead[],
    question: string,
  ): void {
    this.patchDraftEdit(draftId, drafts, (edit) => ({ ...edit, question }));
  }

  setEditChoice(
    draftId: string,
    drafts: readonly QuestionDraftRead[],
    index: number,
    choice: string,
  ): void {
    this.patchDraftEdit(draftId, drafts, (edit) => {
      const choices = [...edit.choices];
      choices[index] = choice;
      return { ...edit, choices };
    });
  }

  addEditChoice(draftId: string, drafts: readonly QuestionDraftRead[]): void {
    this.patchDraftEdit(draftId, drafts, (edit) => ({
      ...edit,
      choices: [...edit.choices, ''],
    }));
  }

  removeEditChoice(
    draftId: string,
    drafts: readonly QuestionDraftRead[],
    index: number,
  ): void {
    this.patchDraftEdit(draftId, drafts, (edit) => {
      const choices = edit.choices.filter(
        (_, choiceIndex) => choiceIndex !== index,
      );
      const answer = choices.includes(edit.answer) ? edit.answer : '';
      return { ...edit, choices, answer };
    });
  }

  setEditAnswer(
    draftId: string,
    drafts: readonly QuestionDraftRead[],
    answer: string,
  ): void {
    this.patchDraftEdit(draftId, drafts, (edit) => ({ ...edit, answer }));
  }

  setEditRationale(
    draftId: string,
    drafts: readonly QuestionDraftRead[],
    rationale: string,
  ): void {
    this.patchDraftEdit(draftId, drafts, (edit) => ({ ...edit, rationale }));
  }

  updatePayload(draft: QuestionDraftRead) {
    return this.edits.updatePayload(draft, this.draftEdit(draft));
  }

  generatePayload(limit: number, strategy: DraftGenerationStrategy) {
    return this.edits.generatePayload(limit, strategy);
  }

  private patchDraftEdit(
    draftId: string,
    drafts: readonly QuestionDraftRead[],
    updater: (edit: DraftEdit) => DraftEdit,
  ): void {
    const draft = drafts.find((candidate) => candidate.id === draftId);
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
}
