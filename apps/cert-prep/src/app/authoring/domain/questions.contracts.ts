/**
 * Available question-generation routes. Deterministic generation is local rules;
 * hybrid reasoning may call the optional local reasoning model.
 */
export type QuestionGenerationStrategy =
  | 'deterministic_only'
  | 'hybrid_reasoning';

/**
 * Editable subset of a question shown in the editor.
 */
export interface QuestionEdit {
  question: string;
  choices: string[];
  answer: string;
  rationale: string;
}

export type QuestionJobSummarySeverity =
  | 'secondary'
  | 'info'
  | 'success'
  | 'warn'
  | 'danger';

export interface QuestionJobSummary {
  total: number;
  active: number;
  succeeded: number;
  skipped: number;
  failed: number;
  generatedCount: number;
  label: string;
  detail: string;
  severity: QuestionJobSummarySeverity;
}
