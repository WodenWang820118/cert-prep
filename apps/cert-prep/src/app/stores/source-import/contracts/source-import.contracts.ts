import type { DocumentRead } from '../../../cert-prep-api';

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

export type SourceUploadStatus =
  | 'queued'
  | 'uploading'
  | 'cancel_requested'
  | 'status_unavailable'
  | 'canceled'
  | 'uploaded'
  | 'failed';

export interface SourceUploadItem {
  readonly id: string;
  readonly file: File;
  readonly status: SourceUploadStatus;
  readonly document: DocumentRead | null;
  readonly error: string | null;
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
