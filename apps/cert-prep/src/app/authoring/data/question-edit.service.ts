import { Injectable } from '@angular/core';
import type {
  QuestionGenerateRequest,
  QuestionRead,
  QuestionUpdate,
} from '../../core/domain';
import type { QuestionEdit, QuestionGenerationStrategy } from '../domain';

/**
 * Normalizes editable question form input before saving it back to the API.
 */
@Injectable({ providedIn: 'root' })
export class QuestionEditService {
  clampQuestionLimit(value: string | number): number {
    return this.clampInteger(value, 1, 50);
  }

  editFromQuestion(question: QuestionRead): QuestionEdit {
    return {
      question: question.question,
      choices: question.choices.length > 0 ? [...question.choices] : ['', ''],
      answer: question.answer ?? '',
      rationale: question.rationale ?? '',
    };
  }

  updatePayload(
    question: QuestionRead,
    edit: QuestionEdit,
  ): QuestionUpdate {
    const choices = this.normalizeChoices(edit.choices);
    const answer = edit.answer.trim();
    return {
      question: edit.question.trim(),
      choices,
      answer: answer.length > 0 ? answer : null,
      answer_key_source: 'manual',
      rationale: this.emptyToNull(edit.rationale),
      citation_page: question.citation_page,
      source_excerpt: question.source_excerpt,
    };
  }

  generatePayload(
    limit: number,
    strategy: QuestionGenerationStrategy,
  ): QuestionGenerateRequest {
    return {
      limit,
      strategy,
    } as QuestionGenerateRequest & { strategy: QuestionGenerationStrategy };
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
