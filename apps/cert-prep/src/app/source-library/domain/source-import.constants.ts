
export const DEFAULT_UPLOAD_BATCH_SIZE = 2;
export const MIN_UPLOAD_BATCH_SIZE = 1;
export const MAX_UPLOAD_BATCH_SIZE = 4;

export const SOURCE_FILE_ACCEPT =
  '.pdf,.png,.jpg,.jpeg,.webp,.mp3,.wav,.m4a,application/pdf,image/png,image/jpeg,image/webp,audio/mpeg,audio/wav,audio/mp4';
export const SUPPORTED_SOURCE_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/x-m4a',
]);
export const SUPPORTED_SOURCE_FILE_EXTENSIONS = [
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.mp3',
  '.wav',
  '.m4a',
] as const;
export const FINAL_SOURCE_STATUSES = new Set([
  'ready',
  'no_text_detected',
  'extraction_failed',
  'transcription_failed',
  'canceled',
]);
export const TRANSCRIPT_MUTATION_ACTIONS = [
  'transcript-edit',
  'transcript-translate',
  'transcript-translate-all',
] as const;

export const INITIAL_CHUNK_PREVIEW_LIMIT = 6;
export const CHUNK_PREVIEW_STEP = 6;
