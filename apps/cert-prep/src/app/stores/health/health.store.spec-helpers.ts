import type {
  LLMHealthRead,
  ModelDownloadRead,
  OCRHealthRead,
  RuntimeInstallationRead,
} from '../../cert-prep-api';

export function llmHealth(overrides: Partial<LLMHealthRead> = {}): LLMHealthRead {
  return {
    provider: 'ollama',
    model: 'reasoner:7b',
    available: false,
    detail: 'model not found',
    unavailable_reason: 'model_missing',
    ...overrides,
  };
}

export function modelDownload(
  overrides: Partial<ModelDownloadRead> = {},
): ModelDownloadRead {
  return {
    id: 'job-1',
    provider: 'ollama',
    model: 'reasoner:7b',
    status: 'running',
    detail: 'downloading',
    completed: 25,
    total: 100,
    created_at: '2026-06-11T00:00:00Z',
    updated_at: '2026-06-11T00:00:00Z',
    ...overrides,
  };
}

export function ocrHealth(): OCRHealthRead {
  return {
    provider: 'paddle',
    engine: 'paddleocr',
    available: true,
    detail: 'PaddleOCR imports available',
    python_version: '3.13.5',
    paddle_version: '3.3.0',
    paddleocr_version: '3.6.0',
    selected_device: 'cpu',
    cuda_available: false,
    gpu_count: 0,
    model_cache_dir: null,
    fallback_reason: null,
    unavailable_reason: null,
  };
}

export function runtimeInstallation(
  overrides: Partial<RuntimeInstallationRead> = {},
): RuntimeInstallationRead {
  return {
    id: 'runtime-1',
    kind: 'ollama',
    provider: 'ollama',
    model: 'ollama',
    status: 'running',
    detail: 'installing',
    completed: 10,
    total: 100,
    created_at: '2026-06-11T00:00:00Z',
    updated_at: '2026-06-11T00:00:00Z',
    ...overrides,
  };
}
