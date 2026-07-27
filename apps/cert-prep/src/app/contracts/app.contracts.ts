export type StudyPageId =
  | 'build'
  | 'full_exam'
  | 'random_quiz'
  | 'runtime'
  | 'dashboard'
  | 'review'
  | 'capture_workbench_trial';

/**
 * Presentation metadata for one route-backed shell page.
 */
export interface StudyPageOption {
  readonly id: StudyPageId;
  readonly label: string;
  readonly icon: string;
  readonly path: string;
}
