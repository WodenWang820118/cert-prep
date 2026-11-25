import { inject, Injectable, signal } from '@angular/core';
import type { QuestionRead } from '../../core/domain';
import type { QuestionEdit, QuestionGenerationStrategy } from '../domain';
import { QuestionEditService } from './question-edit.service';

@Injectable({ providedIn: 'root' })
export class QuestionEditSessionStore {
  private readonly edits = inject(QuestionEditService);

  readonly editingQuestionId = signal<string | null>(null);
  readonly questionEdits = signal<Record<string, QuestionEdit>>({});

  reset(): void {
    this.editingQuestionId.set(null);
    this.questionEdits.set({});
  }

  isEditing(question: QuestionRead): boolean {
    return this.editingQuestionId() === question.id;
  }

  questionEdit(question: QuestionRead): QuestionEdit {
    return this.questionEdits()[question.id] ?? this.edits.editFromQuestion(question);
  }

  startEdit(question: QuestionRead): void {
    this.questionEdits.update((edits) => ({
      ...edits,
      [question.id]: this.edits.editFromQuestion(question),
    }));
    this.editingQuestionId.set(question.id);
  }

  cancelEdit(question: QuestionRead): void {
    this.removeQuestionEdit(question.id);
    if (this.editingQuestionId() === question.id) {
      this.editingQuestionId.set(null);
    }
  }

  setEditQuestion(
    questionId: string,
    questions: readonly QuestionRead[],
    question: string,
  ): void {
    this.patchQuestionEdit(questionId, questions, (edit) => ({ ...edit, question }));
  }

  setEditChoice(
    questionId: string,
    questions: readonly QuestionRead[],
    index: number,
    choice: string,
  ): void {
    this.patchQuestionEdit(questionId, questions, (edit) => {
      const choices = [...edit.choices];
      choices[index] = choice;
      return { ...edit, choices };
    });
  }

  addEditChoice(questionId: string, questions: readonly QuestionRead[]): void {
    this.patchQuestionEdit(questionId, questions, (edit) => ({
      ...edit,
      choices: [...edit.choices, ''],
    }));
  }

  removeEditChoice(
    questionId: string,
    questions: readonly QuestionRead[],
    index: number,
  ): void {
    this.patchQuestionEdit(questionId, questions, (edit) => {
      const choices = edit.choices.filter(
        (_, choiceIndex) => choiceIndex !== index,
      );
      const answer = choices.includes(edit.answer) ? edit.answer : '';
      return { ...edit, choices, answer };
    });
  }

  setEditAnswer(
    questionId: string,
    questions: readonly QuestionRead[],
    answer: string,
  ): void {
    this.patchQuestionEdit(questionId, questions, (edit) => ({ ...edit, answer }));
  }

  setEditRationale(
    questionId: string,
    questions: readonly QuestionRead[],
    rationale: string,
  ): void {
    this.patchQuestionEdit(questionId, questions, (edit) => ({ ...edit, rationale }));
  }

  updatePayload(question: QuestionRead) {
    return this.edits.updatePayload(question, this.questionEdit(question));
  }

  generatePayload(limit: number, strategy: QuestionGenerationStrategy) {
    return this.edits.generatePayload(limit, strategy);
  }

  private patchQuestionEdit(
    questionId: string,
    questions: readonly QuestionRead[],
    updater: (edit: QuestionEdit) => QuestionEdit,
  ): void {
    const question = questions.find((candidate) => candidate.id === questionId);
    const current =
      this.questionEdits()[questionId] ??
      (question ? this.edits.editFromQuestion(question) : null);
    if (current === null) {
      return;
    }
    this.questionEdits.update((edits) => ({
      ...edits,
      [questionId]: updater(current),
    }));
  }

  private removeQuestionEdit(questionId: string): void {
    this.questionEdits.update((edits) => {
      const next = { ...edits };
      delete next[questionId];
      return next;
    });
  }
}
