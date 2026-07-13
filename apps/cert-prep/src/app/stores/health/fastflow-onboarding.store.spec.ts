import { TestBed } from '@angular/core/testing';
import type { LLMProviderSelectionRead } from '../../cert-prep-api';
import { CERT_PREP_API } from '../../cert-prep-api';
import { OperationStore } from '../operation.store';
import { FastFlowOnboardingStore } from './fastflow-onboarding.store';

type ProviderSelection = LLMProviderSelectionRead;

const TERMS_URL =
  'https://raw.githubusercontent.com/FastFlowLM/FastFlowLM/v0.9.43/src/inno/terms.txt';

describe('FastFlowOnboardingStore', () => {
  const apiClient = {
    llmProviderSelection: vi.fn(),
    decideFastflowlmTerms: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.llmProviderSelection.mockResolvedValue(fastFlowSelection());
    apiClient.decideFastflowlmTerms.mockResolvedValue(
      fastFlowSelection({ terms_accepted: true }),
    );
    TestBed.configureTestingModule({
      providers: [{ provide: CERT_PREP_API, useValue: apiClient }],
    });
  });

  it('loads only a reviewable FastFlowLM selection and exposes exact terms', async () => {
    const store = TestBed.inject(FastFlowOnboardingStore);

    await store.open(true);

    expect(apiClient.llmProviderSelection).toHaveBeenCalledOnce();
    expect(store.consentVisible()).toBe(true);
    expect(store.loading()).toBe(false);
    expect(store.selection()?.selected_provider).toBe('fastflowlm');
    expect(store.termsVersion()).toBe('0.9.43');
    expect(store.termsUrl()).toBe(TERMS_URL);
  });

  it('does not accept terms until the user acknowledges them', async () => {
    const store = TestBed.inject(FastFlowOnboardingStore);
    const refresh = vi.fn().mockResolvedValue(undefined);
    await store.open(true);

    await store.accept(refresh);

    expect(apiClient.decideFastflowlmTerms).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(store.consentVisible()).toBe(true);
  });

  it('accepts the exact displayed terms version and refreshes after closing', async () => {
    const store = TestBed.inject(FastFlowOnboardingStore);
    const refresh = vi.fn().mockResolvedValue(undefined);
    await store.open(true);
    store.setAcknowledged(true);

    await store.accept(refresh);

    expect(apiClient.decideFastflowlmTerms).toHaveBeenCalledWith({
      decision: 'accepted',
      terms_version: '0.9.43',
    });
    expect(store.consentVisible()).toBe(false);
    expect(store.acknowledged()).toBe(false);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('records an explicit decline without requiring acknowledgement', async () => {
    const store = TestBed.inject(FastFlowOnboardingStore);
    const refresh = vi.fn().mockResolvedValue(undefined);
    apiClient.decideFastflowlmTerms.mockResolvedValue(
      fastFlowSelection({
        selected_provider: 'ollama',
        effective_provider: 'ollama',
        requires_terms_acceptance: false,
        terms_version: null,
        terms_url: null,
        runtime_requirement_kind: 'ollama',
        model_requirement_kind: 'ollama_model',
      }),
    );
    await store.open(true);

    await store.decline(refresh);

    expect(apiClient.decideFastflowlmTerms).toHaveBeenCalledWith({
      decision: 'declined',
      terms_version: '0.9.43',
    });
    expect(store.consentVisible()).toBe(false);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each([
    ['wrong provider', { selected_provider: 'ollama' }],
    ['incompatible hardware', { hardware_compatible: false }],
    ['terms not required', { requires_terms_acceptance: false }],
    ['already accepted', { terms_accepted: true }],
    ['blank version', { terms_version: '  ' }],
    ['non-https URL', { terms_url: TERMS_URL.replace('https:', 'http:') }],
    [
      'unofficial URL',
      { terms_url: 'https://example.com/FastFlowLM/terms.txt' },
    ],
    [
      'mismatched version URL',
      { terms_url: TERMS_URL.replace('v0.9.43', 'v0.9.42') },
    ],
    [
      'matching but unapproved version and URL',
      {
        terms_version: '0.9.44',
        terms_url: TERMS_URL.replace('0.9.43', '0.9.44'),
      },
    ],
  ])('fails closed for %s', async (_label, overrides) => {
    const store = TestBed.inject(FastFlowOnboardingStore);
    const operations = TestBed.inject(OperationStore);
    apiClient.llmProviderSelection.mockResolvedValue(
      fastFlowSelection(overrides),
    );

    await store.open(true);

    expect(store.consentVisible()).toBe(false);
    expect(store.selection()).toBeNull();
    expect(operations.error()).toContain('could not be verified');
  });

  it('does not fetch selection when review is not allowed', async () => {
    const store = TestBed.inject(FastFlowOnboardingStore);

    await store.open(false);

    expect(apiClient.llmProviderSelection).not.toHaveBeenCalled();
    expect(store.consentVisible()).toBe(false);
  });

  it('records provider-selection and decision failures without opening or closing incorrectly', async () => {
    const store = TestBed.inject(FastFlowOnboardingStore);
    const operations = TestBed.inject(OperationStore);
    apiClient.llmProviderSelection.mockRejectedValueOnce(
      new Error('selection unavailable'),
    );

    await store.open(true);

    expect(store.consentVisible()).toBe(false);
    expect(operations.error()).toBe('selection unavailable');

    apiClient.llmProviderSelection.mockResolvedValueOnce(fastFlowSelection());
    apiClient.decideFastflowlmTerms.mockRejectedValueOnce({
      error: { message: 'decision rejected' },
    });
    await store.open(true);
    store.setAcknowledged(true);
    await store.accept(vi.fn().mockResolvedValue(undefined));

    expect(store.consentVisible()).toBe(true);
    expect(store.decisionSaving()).toBe(false);
    expect(operations.error()).toBe('decision rejected');
  });

  it('keeps consent open when the decision response is not the expected transition', async () => {
    const store = TestBed.inject(FastFlowOnboardingStore);
    const operations = TestBed.inject(OperationStore);
    const refresh = vi.fn().mockResolvedValue(undefined);
    apiClient.decideFastflowlmTerms.mockResolvedValueOnce(fastFlowSelection());
    await store.open(true);
    store.setAcknowledged(true);

    await store.accept(refresh);

    expect(store.consentVisible()).toBe(true);
    expect(store.acknowledged()).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    expect(operations.error()).toContain('could not be verified');
  });

  it('rejects a decline response with contradictory FastFlowLM requirement kinds', async () => {
    const store = TestBed.inject(FastFlowOnboardingStore);
    const operations = TestBed.inject(OperationStore);
    apiClient.decideFastflowlmTerms.mockResolvedValueOnce(
      fastFlowSelection({
        selected_provider: 'ollama',
        effective_provider: 'ollama',
        requires_terms_acceptance: false,
        terms_version: null,
        terms_url: null,
      }),
    );
    await store.open(true);

    await store.decline(vi.fn().mockResolvedValue(undefined));

    expect(store.consentVisible()).toBe(true);
    expect(operations.error()).toContain('could not be verified');
  });

  it('keeps consent open when post-decision health refresh fails', async () => {
    const store = TestBed.inject(FastFlowOnboardingStore);
    const operations = TestBed.inject(OperationStore);
    const refresh = vi.fn().mockRejectedValue(new Error('refresh failed'));
    await store.open(true);
    store.setAcknowledged(true);

    await store.accept(refresh);

    expect(store.consentVisible()).toBe(true);
    expect(store.acknowledged()).toBe(true);
    expect(operations.error()).toBe('refresh failed');
  });
});

function fastFlowSelection(
  overrides: Partial<ProviderSelection> = {},
): ProviderSelection {
  return {
    preference: 'auto',
    selected_provider: 'fastflowlm',
    effective_provider: 'fastflowlm',
    configured_model: 'qwen3.5:4b',
    effective_model: 'qwen3.5:4b',
    selection_reason: 'Compatible XDNA2 hardware detected.',
    fallback_reason: null,
    hardware_compatible: true,
    requires_terms_acceptance: true,
    terms_accepted: false,
    terms_version: '0.9.43',
    terms_url: TERMS_URL,
    runtime_requirement_kind: 'fastflowlm',
    model_requirement_kind: 'fastflowlm_model',
    ...overrides,
  };
}
