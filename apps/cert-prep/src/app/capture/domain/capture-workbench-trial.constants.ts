export const STREAMING_EVENT_TYPES = new Set([
  'accepted',
  'input_checkpoint',
  'heartbeat',
  'segment',
  'checkpoint',
  'resync_required',
  'completed',
  'failed',
  'cancelled',
]);

// Cert Prep may batch all pages from a multi-page PDF into one segment event.
// Keep the per-line bound aligned with the existing bounded frame/payload
// limits so a valid batched event is not rejected before JSON validation.
export const MAX_SSE_LINE_BYTES = 8 * 1024 * 1024;
export const MAX_SSE_FRAME_LINES = 1024;
export const MAX_SSE_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_SSE_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_SSE_SEGMENTS = 10_000;
