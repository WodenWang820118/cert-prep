import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import { HealthStore } from './health.store';
import {
  llmHealth,
  modelDownload,
  ocrHealth,
  providerSelection,
} from './health.store.spec-helpers';

describe('HealthStore model downloads', () => {
  const apiClient = {
    health: vi.fn(),
    llmHealth: vi.fn(),
    llmProviderSelection: vi.fn(),
    decideFastflowlmTerms: vi.fn(),
    ocrHealth: vi.fn(),
    runtimeRequirements: vi.fn(),
    startModelDownload: vi.fn(),
    getModelDownload: vi.fn(),
    cancelModelDownload: vi.fn(),
    startRuntimeInstallation: vi.fn(),
    getRuntimeInstallation: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    apiClient.health.mockResolvedValue({
      status: 'ok',
      app: 'cert-prep-backend',
      version: '0.1.0',
      python_version: '3.13.5',
      runtime_mode: 'source',
    });
    apiClient.llmHealth.mockResolvedValue(llmHealth({ available: false }));
    apiClient.llmProviderSelection.mockResolvedValue(
      providerSelection({
        selected_provider: 'ollama',
        effective_provider: 'ollama',
        selection_reason: 'Auto-selected Ollama for this device.',
        hardware_compatible: false,
        requires_terms_acceptance: false,
        terms_version: null,
        terms_url: null,
        runtime_requirement_kind: 'ollama',
        model_requirement_kind: 'ollama_model',
      }),
    );
    apiClient.ocrHealth.mockResolvedValue({
      ...ocrHealth(),
      fallback_reason: 'cuda_unavailable',
    });
    apiClient.runtimeRequirements.mockResolvedValue({ items: [] });
    TestBed.configureTestingModule({
      providers: [{ provide: CERT_PREP_API, useValue: apiClient }],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not start a model download when consent is cancelled', async () => {
    const store = TestBed.inject(HealthStore);
    await store.load();

    store.openModelDownloadConsent();
    store.cancelModelDownloadConsent();

    expect(store.modelDownloadConsentVisible()).toBe(false);
    expect(apiClient.startModelDownload).not.toHaveBeenCalled();
  });

  it('starts and polls a model download only after confirmation', async () => {
    const store = TestBed.inject(HealthStore);
    apiClient.startModelDownload.mockResolvedValue(
      modelDownload({ status: 'running', detail: 'downloading', completed: 25 }),
    );
    apiClient.getModelDownload.mockResolvedValue(
      modelDownload({
        status: 'succeeded',
        detail: 'model download complete',
        completed: 100,
      }),
    );
    await store.load();

    store.openModelDownloadConsent();
    await store.confirmModelDownload();

    expect(apiClient.startModelDownload).toHaveBeenCalledTimes(1);
    expect(store.modelDownloadConsentVisible()).toBe(false);
    expect(store.modelDownload()?.phase).toBe('running');
    expect(store.modelDownload()?.progress).toBe(25);

    await vi.advanceTimersByTimeAsync(1500);

    expect(apiClient.getModelDownload).toHaveBeenCalledWith('job-1');
    expect(store.modelDownload()?.phase).toBe('succeeded');
    expect(store.modelDownload()?.progress).toBe(100);
  });

  it('does not offer download for an available model', async () => {
    const store = TestBed.inject(HealthStore);
    apiClient.llmHealth.mockResolvedValue(llmHealth({ available: true }));

    await store.load();
    store.openModelDownloadConsent();
    await store.confirmModelDownload();

    expect(store.modelDownloadConsentVisible()).toBe(false);
    expect(apiClient.startModelDownload).not.toHaveBeenCalled();
  });

  it('offers primary model download when runtime is using a fallback model', async () => {
    const store = TestBed.inject(HealthStore);
    apiClient.llmHealth.mockResolvedValue(
      llmHealth({
        available: true,
        model: 'qwen3.5:4b',
        detail: 'model available via fallback qwen3.5:2b',
        unavailable_reason: null,
        configured_model: 'qwen3.5:4b',
        effective_model: 'qwen3.5:2b',
        fallback_models: ['qwen3.5:2b'],
        fallback_reason:
          'Configured model qwen3.5:4b is missing; using fallback qwen3.5:2b.',
      }),
    );
    apiClient.startModelDownload.mockResolvedValue(
      modelDownload({
        model: 'qwen3.5:4b',
        status: 'succeeded',
        detail: 'model download complete',
        completed: 100,
      }),
    );

    await store.load();
    store.openModelDownloadConsent();
    await store.confirmModelDownload();

    expect(store.modelDownloadConsentVisible()).toBe(false);
    expect(apiClient.startModelDownload).toHaveBeenCalledTimes(1);
    expect(store.modelDownload()?.model).toBe('qwen3.5:4b');
    expect(store.modelDownload()?.phase).toBe('succeeded');
  });

  it('persists exact FastFlow terms before starting the official model pull', async () => {
    const store = TestBed.inject(HealthStore);
    const fastFlowSelection = providerSelection();
    apiClient.llmProviderSelection.mockResolvedValue(fastFlowSelection);
    apiClient.decideFastflowlmTerms.mockResolvedValue({
      ...fastFlowSelection,
      terms_accepted: true,
    });
    apiClient.llmHealth.mockResolvedValue(
      llmHealth({
        provider: 'fastflowlm',
        model: 'qwen3.5:4b',
        available: false,
        detail: 'FastFlowLM model is missing.',
        unavailable_reason: 'model_missing',
        configured_model: 'qwen3.5:4b',
        effective_model: 'qwen3.5:4b',
      }),
    );
    apiClient.runtimeRequirements.mockResolvedValue({
      items: [
        {
          kind: 'fastflowlm',
          label: 'FastFlowLM',
          available: true,
          detail: 'FastFlowLM is ready.',
          unavailable_reason: null,
        },
        {
          kind: 'fastflowlm_model',
          label: 'FastFlowLM model',
          available: false,
          detail: 'qwen3.5:4b is missing.',
          unavailable_reason: 'model_missing',
        },
      ],
    });
    apiClient.startModelDownload.mockResolvedValue(
      modelDownload({
        provider: 'fastflowlm',
        model: 'qwen3.5:4b',
        status: 'running',
      }),
    );
    await store.load();

    store.openModelDownloadConsent();
    store.setFastFlowTermsAcknowledged(true);
    await store.confirmModelDownload();

    expect(apiClient.decideFastflowlmTerms).toHaveBeenCalledWith({
      decision: 'accepted',
      terms_version: '0.9.43',
    });
    expect(apiClient.startModelDownload).toHaveBeenCalledWith({
      fastflowlm_terms_accepted_version: '0.9.43',
    });
    expect(
      apiClient.decideFastflowlmTerms.mock.invocationCallOrder[0],
    ).toBeLessThan(apiClient.startModelDownload.mock.invocationCallOrder[0]);
  });

  it('cancels an active model download through the generated API', async () => {
    const store = TestBed.inject(HealthStore);
    apiClient.startModelDownload.mockResolvedValue(
      modelDownload({ status: 'running', phase: 'downloading' }),
    );
    apiClient.cancelModelDownload.mockResolvedValue(
      modelDownload({
        status: 'canceled',
        phase: 'canceled',
        cancellable: false,
      }),
    );
    await store.load();
    store.openModelDownloadConsent();
    await store.confirmModelDownload();

    await store.cancelModelDownload();

    expect(apiClient.cancelModelDownload).toHaveBeenCalledWith('job-1');
    expect(store.modelDownload()?.phase).toBe('canceled');
    expect(store.canCancelModelDownload()).toBe(false);
  });
});
