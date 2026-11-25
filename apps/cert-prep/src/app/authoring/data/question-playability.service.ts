import { Injectable } from '@angular/core';
import type { QuestionRead } from '../../core/domain';

@Injectable({ providedIn: 'root' })
export class QuestionPlayabilityService {
  isPlayableQuestion(question: QuestionRead): boolean {
    const choices = this.nonEmptyValues(question.choices);
    const answer = this.trimmedValue(question.answer);
    return (
      this.hasText(question.question) &&
      choices.length >= 2 &&
      answer.length > 0 &&
      choices.includes(answer) &&
      this.hasText(question.rationale) &&
      this.hasEvidence(question) &&
      this.hasSourceQuestionIdentity(question)
    );
  }

  private nonEmptyValues(values: string[]): string[] {
    return values
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  private hasText(value: string | null): boolean {
    return this.trimmedValue(value).length > 0;
  }

  private trimmedValue(value: string | null): string {
    return value?.trim() ?? '';
  }

  private hasEvidence(question: QuestionRead): boolean {
    return question.citation_page !== null || this.hasText(question.source_excerpt);
  }

  private hasSourceQuestionIdentity(question: QuestionRead): boolean {
    return this.hasText(question.source_question_number);
  }
}
