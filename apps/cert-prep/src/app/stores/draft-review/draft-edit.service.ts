import { Injectable } from '@angular/core';
import type {
  DraftGenerateRequest,
  QuestionDraftRead,
  QuestionDraftUpdate,
} from '../../cert-prep-api';
import type {
  DraftEdit,
  DraftGenerationStrategy,
} from './contracts/draft-review.contracts';

/**
 * Normalizes editable question form input before saving it back to the API.
 */
@Injectable({ providedIn: 'root' })
export class DraftEditService {
  clampQuestionLimit(value: string | number): number {
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
