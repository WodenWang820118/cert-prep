export const RUNTIME_JOB_POLL_INTERVAL_MS = 1500;
export const OCR_RUNTIME_MISSING_REASON_CODES = new Set([
  'paddle_runtime_missing',
  'windowsml_runtime_missing',
]);
export const LLM_RUNTIME_MISSING_REASON_CODES = new Set(['ollama_missing']);

export const RUNTIME_KIND_LABELS: Record<string, string> = {
  ollama: 'Ollama',
  ollama_model: 'Ollama model',
  paddle_ocr: 'PaddleOCR runtime',
  windowsml_ocr: 'WindowsML OCR runtime',
  whisper_models: 'Whisper speech models',
};
