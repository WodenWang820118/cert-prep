import { Injectable } from '@angular/core';
import type { QuestionDraftRead } from '../../cert-prep-api';

const PLAYABLE_DRAFT_STATUS = 'approved';

@Injectable({ providedIn: 'root' })
export class DraftPlayabilityService {
  isPlayableDraft(draft: QuestionDraftRead): boolean {
    const choices = this.nonEmptyValues(draft.choices);
    const answer = this.trimmedValue(draft.answer);
    return (
      draft.status === PLAYABLE_DRAFT_STATUS &&
      this.hasText(draft.question) &&
      choices.length >= 2 &&
      answer.length > 0 &&
      choices.includes(answer) &&
      this.hasText(draft.rationale) &&
      this.hasEvidence(draft)
    );
  }

  statusLabel(draft: QuestionDraftRead): string {
    return this.isPlayableDraft(draft) ? 'Playable' : 'Not playable';
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

  private hasEvidence(draft: QuestionDraftRead): boolean {
    return draft.citation_page !== null || this.hasText(draft.source_excerpt);
  }
}
