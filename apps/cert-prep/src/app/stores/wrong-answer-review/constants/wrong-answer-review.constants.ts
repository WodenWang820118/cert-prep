import type { WrongAnswerExplanationState } from '../contracts/wrong-answer-review.contracts';

export const EMPTY_EXPLANATION_STATE: WrongAnswerExplanationState = {
  loading: false,
  result: null,
  error: null,
  fallback: false,
};
