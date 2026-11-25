export type QuestionGenerationTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger';

export interface QuestionGenerationMessageInput {
  readonly sourceReady: boolean;
  readonly sourceProcessing: boolean;
  readonly hasQuestions: boolean;
  readonly isPreparing: boolean;
  readonly hasGenerationError: boolean;
  readonly hasReviewEvidence: boolean;
  readonly zeroQuestionsGenerated: boolean;
}

export interface QuestionGenerationMessage {
  readonly message: string;
  readonly tone: QuestionGenerationTone;
}

export interface QuestionEditValuesLike {
  readonly question: string;
  readonly choices: readonly string[];
  readonly answer: string;
  readonly rationale: string;
}

export interface QuestionEvidenceViewModel {
  readonly citationPage: number | null;
  readonly sourceExcerpt: string | null;
}

export interface QuestionGenerationStatusViewModel {
  readonly message: string;
  readonly tone: QuestionGenerationTone;
  readonly canGenerate: boolean;
  readonly generateBusy: boolean;
  readonly canRetry: boolean;
  readonly retryBusy: boolean;
  readonly canCancel: boolean;
  readonly cancelBusy: boolean;
  readonly reviewEvidence: readonly QuestionEvidenceViewModel[];
}

export type QuestionGenerationAction =
  | { readonly type: 'generate' }
  | { readonly type: 'retry' }
  | { readonly type: 'cancel' };

export interface QuestionEditViewModel {
  readonly question: string;
  readonly choices: readonly string[];
  readonly answer: string;
  readonly rationale: string;
}

export interface QuestionEditorViewModel {
  /** Internal identity used by the coordinator; the card never renders it. */
  readonly id: string;
  readonly fieldPrefix: string;
  readonly question: string;
  readonly choices: readonly string[];
  readonly answer: string;
  readonly rationale: string;
  readonly citationPage: number | null;
  readonly sourceExcerpt: string | null;
  readonly isEditing: boolean;
  readonly edit: QuestionEditViewModel | null;
  readonly saveBusy: boolean;
  readonly answerKeySource: string | null;
}

export type QuestionEditorAction =
  | { readonly type: 'start-edit' }
  | { readonly type: 'cancel-edit' }
  | { readonly type: 'save' }
  | { readonly type: 'set-question'; readonly value: string }
  | {
      readonly type: 'set-choice';
      readonly index: number;
      readonly value: string;
    }
  | { readonly type: 'add-choice' }
  | { readonly type: 'remove-choice'; readonly index: number }
  | { readonly type: 'set-answer'; readonly value: string }
  | { readonly type: 'set-rationale'; readonly value: string };
