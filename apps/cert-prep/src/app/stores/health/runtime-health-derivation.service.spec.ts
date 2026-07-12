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
});

function llmHealth(
  overrides: Partial<LLMHealthRead> = {},
): LLMHealthRead {
  return {
    provider: 'ollama',
    model: 'qwen3.5:4b',
    available: false,
    detail: 'model not found',
    unavailable_reason: null,
    ...overrides,
  };
}
