import { Injectable } from '@angular/core';
import type {
  DraftGenerateRequest,
  QuestionDraftRead,
  QuestionDraftUpdate,
} from '../../exam-prep-api';
import type {
  DraftEdit,
  DraftGenerationStrategy,
} from './contracts/draft-review.contracts';

/**
 * Encapsulates draft form normalization and approval validation rules.
 */
@Injectable({ providedIn: 'root' })
export class DraftEditService {
  clampDraftLimit(value: string | number): number {
    return this.clampInteger(value, 1, 50);
  }

  editFromDraft(draft: QuestionDraftRead): DraftEdit {
    return {
      question: draft.question,
      choices: draft.choices.length > 0 ? [...draft.choices] : ['', ''],
      answer: draft.answer ?? '',
      rationale: draft.rationale ?? '',
    };
  }

  approvalBlockers(draft: QuestionDraftRead, edit: DraftEdit): string[] {
    const choices = this.normalizeChoices(edit.choices);
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
    if (!this.hasText(draft.source_excerpt)) {
      blockers.push('missing source excerpt');
    }
    if (!this.hasText(answer)) {
      blockers.push('missing answer');
    } else if (!choices.includes(answer)) {
      blockers.push('choice mismatch');
    }
    if (choices.length < 2) {
      blockers.push('choice mismatch');
    }
    if (!this.hasText(edit.rationale)) {
      blockers.push('missing rationale');
    }

    return Array.from(new Set(blockers));
  }

  updatePayload(
    draft: QuestionDraftRead,
    edit: DraftEdit,
  ): QuestionDraftUpdate {
    const choices = this.normalizeChoices(edit.choices);
    const answer = edit.answer.trim();
    return {
      question: edit.question.trim(),
      choices,
      answer: answer.length > 0 ? answer : null,
      answer_key_source: 'manual',
      rationale: this.emptyToNull(edit.rationale),
      citation_page: draft.citation_page,
      source_excerpt: draft.source_excerpt,
    };
  }

  generatePayload(
    limit: number,
    strategy: DraftGenerationStrategy,
  ): DraftGenerateRequest {
    return {
      limit,
      strategy,
    } as DraftGenerateRequest & { strategy: DraftGenerationStrategy };
  }

  private clampInteger(
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

  private hasText(value: string | null): value is string {
    return value !== null && value.trim().length > 0;
  }

  private normalizeChoices(choices: string[]): string[] {
    return choices
      .map((choice) => choice.trim())
      .filter((choice) => choice.length > 0);
  }

  private emptyToNull(value: string): string | null {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
}
