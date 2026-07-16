import { TestBed } from '@angular/core/testing';
import type { LLMHealthRead } from '../../cert-prep-api';
import { RuntimeHealthDerivationService } from './runtime-health-derivation.service';

describe('RuntimeHealthDerivationService', () => {
  let service: RuntimeHealthDerivationService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(RuntimeHealthDerivationService);
  });

  it('uses only the canonical unavailable_reason for missing models', () => {
    const canonical = llmHealth({ unavailable_reason: 'model_missing' });
    const legacyDiagnostics = {
      ...llmHealth({ unavailable_reason: null }),
      code: 'model_missing',
      error_code: 'model_missing',
      reason: 'model_missing',
    };

    expect(service.isModelMissing(canonical)).toBe(true);
    expect(service.isModelMissing(legacyDiagnostics)).toBe(false);
    expect(
      service.isModelMissing(
        llmHealth({ unavailable_reason: 'missing_model' }),
      ),
    ).toBe(false);
  });

  it('derives a missing Ollama runtime from canonical requirements', () => {
    const requirements = [
      {
        kind: 'ollama',
        label: 'Ollama',
        available: false,
        detail: 'Ollama is not installed.',
        unavailable_reason: 'ollama_missing',
      },
    ];

    expect(service.isOllamaMissing(llmHealth(), requirements)).toBe(true);
    expect(service.isLlmRuntimeMissing(llmHealth(), requirements)).toBe(true);
  });

  it('uses the Ollama model requirement after the runtime is available', () => {
    const requirements = [
      {
        kind: 'ollama',
        label: 'Ollama',
        available: true,
        detail: 'Ollama is installed.',
        unavailable_reason: null,
      },
      {
        kind: 'ollama_model',
        label: 'Ollama model',
        available: false,
        detail: 'qwen3.5:4b is not installed.',
        unavailable_reason: 'model_missing',
      },
    ];
    const health = llmHealth({ unavailable_reason: null });

    expect(service.isModelMissing(health, requirements)).toBe(true);
    expect(service.isConfiguredModelMissing(health, requirements)).toBe(true);
    expect(service.isLlmRuntimeMissing(health, requirements)).toBe(false);
  });

  it('keeps unknown provider labels provider-neutral', () => {
    expect(service.providerLabel('ollama')).toBe('Ollama');
    expect(service.providerLabel('fake')).toBe('Fake LLM');
    expect(service.providerLabel('future-provider')).toBe('LLM provider');
  });
});

function llmHealth(overrides: Partial<LLMHealthRead> = {}): LLMHealthRead {
  return {
    provider: 'ollama',
    model: 'qwen3.5:4b',
    available: false,
    detail: 'model not found',
    unavailable_reason: null,
    ...overrides,
  };
}
