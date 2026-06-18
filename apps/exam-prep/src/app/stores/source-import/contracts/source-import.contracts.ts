/**
 * Optional OCR/parser language hint sent with an uploaded source PDF.
 */
export type LanguageHint =
  | 'auto'
  | 'ja'
  | 'zh-Hant'
  | 'zh-Hans'
  | 'en'
  | 'mixed';

/**
 * Display-ready parsing metric shown on the source document card.
 */
export interface DocumentParsingMetric {
  readonly label: string;
  readonly value: string;
}

/**
 * Source document metric lookup definition for schema variants emitted by the
 * backend during parsing performance experiments.
 */
export interface ParsingMetricDefinition {
  readonly label: string;
  readonly kind: 'duration' | 'count';
  readonly keys: readonly string[];
}
