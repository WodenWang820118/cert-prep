export const DOCUMENT_POLL_INTERVAL_MS = 1500;
export const FIRST_CHUNK_POLL_INTERVAL_MS = 500;
export const POLL_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;
export const TRANSPORT_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;
export const OPERATION_PROGRESS_POLL_MS = 1000;
export const RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

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
export const FINAL_DOCUMENT_STATUSES = new Set([
  'ready',
  'exam_failed',
  'no_text_detected',
  'ocr_failed',
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

export const PARSING_METRIC_DEFINITIONS = [
  {
    label: 'Parse wall time',
    kind: 'duration',
    keys: [
      'parse_wall_time_ms',
      'parse_wall_time_seconds',
      'parse_wall_duration_ms',
      'parseWallTimeMs',
      'parseWallDurationMs',
      'parse_duration_ms',
      'parseDurationMs',
      'parse_elapsed_ms',
      'parseElapsedMs',
    ],
  },
  {
    label: 'Render time',
    kind: 'duration',
    keys: [
      'render_time_ms',
      'render_time_seconds',
      'render_duration_ms',
      'renderDurationMs',
      'pdf_render_duration_ms',
      'pdfRenderDurationMs',
      'page_render_time_ms',
      'pageRenderTimeMs',
      'render_ms',
      'renderMs',
    ],
  },
  {
    label: 'OCR engine time',
    kind: 'duration',
    keys: [
      'ocr_engine_time_ms',
      'ocrEngineTimeMs',
      'ocr_engine_duration_ms',
      'ocrEngineDurationMs',
      'ocr_time_ms',
      'ocrTimeMs',
      'ocr_duration_ms',
      'ocrDurationMs',
    ],
  },
  {
    label: 'Worker count',
    kind: 'count',
    keys: [
      'worker_count',
      'workerCount',
      'workers',
      'ocr_worker_count',
      'ocrWorkerCount',
    ],
  },
  {
    label: 'First chunk time',
    kind: 'duration',
    keys: [
      'first_chunk_time_ms',
      'firstChunkTimeMs',
      'first_chunk_duration_ms',
      'firstChunkDurationMs',
      'first_chunk_latency_ms',
      'firstChunkLatencyMs',
      'first_chunk_ms',
      'firstChunkMs',
      'time_to_first_chunk_ms',
      'timeToFirstChunkMs',
    ],
  },
] as const;
