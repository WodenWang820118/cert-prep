export interface WrongAnswerExplanationState {
  loading: boolean;
  result: string | null;
  error: string | null;
  fallback: boolean;
}

export interface AnswerKeyCorrectionState {
  questionId: string | null;
  saving: boolean;
  message: string | null;
  error: string | null;
}
