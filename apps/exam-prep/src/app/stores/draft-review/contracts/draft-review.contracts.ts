/**
 * Available draft-generation routes. Deterministic generation is local rules;
 * hybrid reasoning may call the optional local reasoning model.
 */
export type DraftGenerationStrategy =
  | 'deterministic_only'
  | 'hybrid_reasoning';

/**
 * Editable subset of a question draft shown in the manual review form.
 */
export interface DraftEdit {
  question: string;
  choices: string[];
  answer: string;
  rationale: string;
}

export type DraftJobSummarySeverity =
  | 'secondary'
  | 'info'
  | 'success'
  | 'warn'
  | 'danger';

export interface DraftJobSummary {
  total: number;
  active: number;
  succeeded: number;
  skipped: number;
  failed: number;
  generatedCount: number;
  label: string;
  detail: string;
  severity: DraftJobSummarySeverity;
}
