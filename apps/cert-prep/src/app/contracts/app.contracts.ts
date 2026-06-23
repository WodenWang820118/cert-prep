/**
 * Top-level workspace modes exposed by the shell navigation.
 */
export type StudyMode = 'build' | 'full_exam' | 'random_quiz' | 'review';

/**
 * Presentation metadata for one shell navigation mode.
 */
export interface StudyModeOption {
  readonly id: StudyMode;
  readonly label: string;
  readonly icon: string;
}
