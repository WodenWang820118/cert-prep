export type DraftGenerationTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger';

export interface DraftGenerationMessageInput {
  readonly sourceReady: boolean;
  readonly sourceProcessing: boolean;
  readonly hasQuestions: boolean;
  readonly isPreparing: boolean;
  readonly hasGenerationError: boolean;
  readonly hasReviewEvidence: boolean;
}

export interface DraftGenerationMessage {
  readonly message: string;
  readonly tone: DraftGenerationTone;
}

export interface DraftEditValuesLike {
  readonly question: string;
  readonly choices: readonly string[];
  readonly answer: string;
  readonly rationale: string;
}

export interface DraftEvidenceViewModel {
  readonly citationPage: number | null;
  readonly sourceExcerpt: string | null;
}

export interface DraftGenerationStatusViewModel {
  readonly message: string;
  readonly tone: DraftGenerationTone;
  readonly canGenerate: boolean;
  readonly generateBusy: boolean;
  readonly canRetry: boolean;
  readonly retryBusy: boolean;
  readonly canCancel: boolean;
  readonly cancelBusy: boolean;
  readonly reviewEvidence: readonly DraftEvidenceViewModel[];
}

export type DraftGenerationAction =
  | { readonly type: 'generate' }
  | { readonly type: 'retry' }
  | { readonly type: 'cancel' };

export interface DraftEditViewModel {
  readonly question: string;
  readonly choices: readonly string[];
  readonly answer: string;
  readonly rationale: string;
}

export interface DraftQuestionEditorViewModel {
  /** Internal identity used by the coordinator; the card never renders it. */
  readonly id: string;
  readonly fieldPrefix: string;
  readonly statusLabel: string;
  readonly question: string;
  readonly choices: readonly string[];
  readonly answer: string;
  readonly rationale: string;
  readonly citationPage: number | null;
  readonly sourceExcerpt: string | null;
  readonly isEditing: boolean;
  readonly edit: DraftEditViewModel | null;
  readonly saveBusy: boolean;
}

export type DraftQuestionEditorAction =
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
