import type {
  AnswerKeyCorrectionState,
  WrongAnswerExplanationState,
} from '../contracts/wrong-answer-review.contracts';

export const EMPTY_EXPLANATION_STATE: WrongAnswerExplanationState = {
  loading: false,
  result: null,
  error: null,
  fallback: false,
};

export const EMPTY_ANSWER_KEY_CORRECTION: AnswerKeyCorrectionState = {
  questionId: null,
  saving: false,
  message: null,
  error: null,
};
