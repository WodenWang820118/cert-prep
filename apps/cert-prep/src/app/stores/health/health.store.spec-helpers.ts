import type {
  LLMHealthRead,
  ModelDownloadRead,
} from '../../contracts/api.contracts';
import type { LLMProviderSelectionRead } from './contracts/health-runtime.contracts';

export function providerSelection(
  overrides: Partial<LLMProviderSelectionRead> = {},
): LLMProviderSelectionRead {
  return {
    preference: 'auto',
    selected_provider: 'ollama',
    effective_provider: 'ollama',
    configured_model: 'qwen3.5:4b',
    effective_model: 'qwen3.5:4b',
    selection_reason: 'Ollama is the selected local reasoning provider.',
    fallback_reason: null,
    runtime_requirement_kind: 'ollama',
    model_requirement_kind: 'ollama_model',
    ...overrides,
  };
}

export function llmHealth(
  overrides: Partial<LLMHealthRead> = {},
): LLMHealthRead {
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
