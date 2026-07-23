import type { WrongAnswerSummaryRead } from '../../../contracts/api.contracts';

export type WrongAnswerCluster = WrongAnswerSummaryRead['clusters'][number];
export type WrongAnswerRepeatedMiss =
  WrongAnswerSummaryRead['repeated_misses'][number];

export interface DashboardMetric {
  readonly label: string;
  readonly value: string;
  readonly tone: 'attention' | 'progress' | 'neutral';
}

export interface WeakAreaView {
  readonly key: string;
  readonly documentLabel: string;
  readonly pageLabel: string;
  readonly currentWrongCount: number;
  readonly clearedCount: number;
  readonly lastWrongLabel: string;
  readonly attemptIds: readonly string[];
}

export interface RepeatedMissView {
  readonly questionId: string;
  readonly question: string;
  readonly documentLabel: string;
  readonly pageLabel: string;
  readonly sourceExcerpt: string | null;
  readonly missCount: number;
  readonly lastWrongLabel: string;
  readonly attemptIds: readonly string[];
}

export interface AnswerPatternView {
  readonly key: string;
  readonly selectedAnswer: string;
  readonly correctAnswer: string;
  readonly count: number;
  readonly samples: readonly string[];
}
