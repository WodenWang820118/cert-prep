import { Injectable } from '@angular/core';
import type {
  PracticeSessionMode,
  PracticeSessionPayload,
} from './contracts/practice.contracts';

/**
 * Builds validated practice-session payloads from current project state.
 */
@Injectable({ providedIn: 'root' })
export class PracticeSessionPayloadService {
  clampQuestionCount(value: string | number): number {
    return this.clampInteger(value, 1, 100);
  }

  effectiveRandomQuestionCount(
    sessionQuestionCount: number,
    questionCount: number,
  ): number {
    if (questionCount <= 0) {
      return 0;
    }

    return Math.min(sessionQuestionCount, questionCount);
  }

  createPayload(args: {
    readonly mode: PracticeSessionMode;
    readonly fullExamDocumentId: string | null;
    readonly selectedDocumentQuestionCount: number;
    readonly sessionQuestionCount: number;
    readonly questionCount: number;
  }): PracticeSessionPayload {
    if (args.mode === 'full_document') {
      return {
        mode: args.mode,
        document_id: args.fullExamDocumentId ?? undefined,
        question_count: Math.max(1, args.selectedDocumentQuestionCount),
      };
    }

    return {
      mode: args.mode,
      question_count: Math.max(
        1,
        this.effectiveRandomQuestionCount(
          args.sessionQuestionCount,
          args.questionCount,
        ),
      ),
    };
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
}
