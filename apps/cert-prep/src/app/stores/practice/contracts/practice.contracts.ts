import type { PracticeSessionCreate } from '../../../cert-prep-api';

/**
 * Practice session modes supported by the project question bank.
 */
export type PracticeSessionMode =
  | 'full_document'
  | 'random_draw'
  | 'review_retry';

/**
 * API payload for session creation, narrowed to the fields this store owns.
 */
export type PracticeSessionPayload = PracticeSessionCreate &
  Partial<{
    mode: PracticeSessionMode;
    document_id: string;
  }>;
