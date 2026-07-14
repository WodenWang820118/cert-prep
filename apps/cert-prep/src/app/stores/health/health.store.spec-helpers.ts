import type {
  LLMHealthRead,
  ModelDownloadRead,
  OCRHealthRead,
  RuntimeInstallationRead,
} from '../../cert-prep-api';
import type { LLMProviderSelectionRead } from './contracts/health-runtime.contracts';

export function providerSelection(
  overrides: Partial<LLMProviderSelectionRead> = {},
): LLMProviderSelectionRead {
  return {
    preference: 'auto',
    selected_provider: 'fastflowlm',
    effective_provider: 'fastflowlm',
    configured_model: 'qwen3.5:4b',
    effective_model: 'qwen3.5:4b',
    selection_reason:
      'Auto-selected FastFlowLM: Windows 11, AMD XDNA2, and the minimum driver were detected.',
    fallback_reason: null,
    hardware_compatible: true,
    requires_terms_acceptance: true,
    terms_accepted: false,
    terms_version: '0.9.43',
    terms_url:
      'https://raw.githubusercontent.com/FastFlowLM/FastFlowLM/v0.9.43/src/inno/terms.txt',
    runtime_requirement_kind: 'fastflowlm',
    model_requirement_kind: 'fastflowlm_model',
    ...overrides,
  };
}

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
    phase: 'downloading',
    cancellable: true,
    detail: 'downloading',
    completed: 25,
    total: 100,
    created_at: '2026-06-11T00:00:00Z',
    updated_at: '2026-06-11T00:00:00Z',
    ...overrides,
  } as ModelDownloadRead;
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
    phase: 'installing',
    cancellable: true,
    detail: 'installing',
    completed: 10,
    total: 100,
    created_at: '2026-06-11T00:00:00Z',
    updated_at: '2026-06-11T00:00:00Z',
    ...overrides,
  } as RuntimeInstallationRead;
}
