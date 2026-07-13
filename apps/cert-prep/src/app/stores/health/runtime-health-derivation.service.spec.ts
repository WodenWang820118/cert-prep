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

  it('gates model onboarding while FastFlowLM terms are required', () => {
    const requirements = [
      {
        kind: 'fastflowlm',
        label: 'FastFlowLM',
        available: true,
        detail: 'FastFlowLM 0.9.43 is installed.',
        unavailable_reason: null,
      },
      {
        kind: 'fastflowlm_model',
        label: 'FastFlowLM model',
        available: false,
        detail: 'FastFlowLM terms must be accepted.',
        unavailable_reason: 'fastflowlm_terms_required',
      },
    ];

    expect(service.isFastFlowTermsRequired(requirements)).toBe(true);
    expect(
      service.isFastFlowMissing(
        llmHealth({
          provider: 'fastflowlm',
          unavailable_reason: 'fastflowlm_not_running',
        }),
        requirements,
      ),
    ).toBe(false);
    expect(
      service.isLlmRuntimeMissing(
        llmHealth({
          provider: 'fastflowlm',
          unavailable_reason: 'fastflowlm_not_running',
        }),
        requirements,
      ),
    ).toBe(true);
  });

  it('distinguishes accepted FastFlowLM runtime installation from terms review', () => {
    const requirements = [
      {
        kind: 'fastflowlm',
        label: 'FastFlowLM',
        available: false,
        detail: 'FastFlowLM is not installed.',
        unavailable_reason: 'fastflowlm_missing',
      },
    ];

    expect(service.isFastFlowTermsRequired(requirements)).toBe(false);
    expect(service.isFastFlowMissing(llmHealth(), requirements)).toBe(true);
    expect(service.isFastFlowInstallationRequired(requirements)).toBe(true);
    expect(service.isFastFlowRuntimeAvailable(requirements)).toBe(false);
    expect(service.isLlmRuntimeMissing(llmHealth(), requirements)).toBe(true);
  });

  it('uses the model requirement after an installed FastFlowLM runtime is stopped', () => {
    const health = llmHealth({
      provider: 'fastflowlm',
      unavailable_reason: 'fastflowlm_not_running',
    });
    const requirements = [
      {
        kind: 'fastflowlm',
        label: 'FastFlowLM',
        available: true,
        detail: 'FastFlowLM 0.9.43 is installed.',
        unavailable_reason: null,
      },
      {
        kind: 'fastflowlm_model',
        label: 'FastFlowLM model',
        available: false,
        detail: 'qwen3.5:4b is not installed.',
        unavailable_reason: 'model_missing',
      },
    ];

    expect(service.isFastFlowRuntimeAvailable(requirements)).toBe(true);
    expect(service.isModelMissing(health, requirements)).toBe(true);
    expect(service.isConfiguredModelMissing(health, requirements)).toBe(true);
    expect(service.isLlmRuntimeMissing(health, requirements)).toBe(false);
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
