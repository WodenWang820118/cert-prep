import type { AppIconName } from '../ui';
export type StudyPageId =
  | 'build'
  | 'whole_source'
  | 'random_draw'
  | 'runtime'
  | 'wrong_answer_summary'
  | 'wrong_answer_retry'
  | 'capture_workbench';

/**
 * Presentation metadata for one route-backed shell page.
 */
export interface StudyPageOption {
  readonly id: StudyPageId;
  readonly label: string;
  readonly icon: AppIconName;
  readonly path: string;
}

export interface StudyNavigationGroup {
  readonly id: 'build' | 'practice' | 'review';
  readonly label: string;
  readonly pages: readonly StudyPageOption[];
}
