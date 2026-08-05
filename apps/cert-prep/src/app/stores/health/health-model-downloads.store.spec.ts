import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import { HealthStore } from './health.store';
import {
  llmHealth,
  modelDownload,
  providerSelection,
} from './health.store.spec-helpers';
import { provideCertPrepHttpResourceClientFake } from '../../testing/cert-prep-http-resource-client.fake';

describe('HealthStore model downloads', () => {
  const apiClient = {
    health: vi.fn(),
    llmHealth: vi.fn(),
    llmProviderSelection: vi.fn(),
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
    apiClient.health.mockReturnValue(of({
      status: 'ok',
      app: 'cert-prep-backend',
      version: '0.1.0',
      python_version: '3.13.5',
      runtime_mode: 'source',
    }));
    apiClient.llmHealth.mockReturnValue(of(llmHealth({ available: false })));
    apiClient.llmProviderSelection.mockReturnValue(of(
      providerSelection({
        selected_provider: 'ollama',
        effective_provider: 'ollama',
        selection_reason: 'Auto-selected Ollama for this device.',
        runtime_requirement_kind: 'ollama',
        model_requirement_kind: 'ollama_model',
      }),
    ));
    apiClient.runtimeRequirements.mockReturnValue(of({ items: [] }));
    TestBed.configureTestingModule({
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        provideCertPrepHttpResourceClientFake(apiClient),
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not start a model download when consent is cancelled', () => {
    const store = TestBed.inject(HealthStore);
    store.load();
    TestBed.tick();

    store.openModelDownloadConsent();
    store.cancelModelDownloadConsent();

    expect(store.modelDownloadConsentVisible()).toBe(false);
    expect(apiClient.startModelDownload).not.toHaveBeenCalled();
  });

  it('starts and polls a model download only after confirmation', () => {
    const store = TestBed.inject(HealthStore);
    apiClient.startModelDownload.mockReturnValue(of(
      modelDownload({
        status: 'running',
        detail: 'downloading',
        completed: 25,
      }),
    ));
    apiClient.getModelDownload.mockReturnValue(of(
      modelDownload({
        status: 'succeeded',
        detail: 'model download complete',
        completed: 100,
      }),
    ));
    store.load();
    TestBed.tick();

    store.openModelDownloadConsent();
    store.confirmModelDownload();
    TestBed.tick();

    expect(apiClient.startModelDownload).toHaveBeenCalledTimes(1);
    expect(store.modelDownloadConsentVisible()).toBe(false);
    expect(store.modelDownload()?.phase).toBe('running');
    expect(store.modelDownload()?.progress).toBe(25);

    vi.advanceTimersByTime(1500);
    TestBed.tick();

    expect(apiClient.getModelDownload).toHaveBeenCalledWith('job-1');
    expect(store.modelDownload()?.phase).toBe('succeeded');
    expect(store.modelDownload()?.progress).toBe(100);
  });

  it('does not offer download for an available model', () => {
    const store = TestBed.inject(HealthStore);
    apiClient.llmHealth.mockReturnValue(of(llmHealth({ available: true })));

    store.load();
    TestBed.tick();
    store.openModelDownloadConsent();
    store.confirmModelDownload();
    TestBed.tick();

    expect(store.modelDownloadConsentVisible()).toBe(false);
    expect(apiClient.startModelDownload).not.toHaveBeenCalled();
  });

  it('starts the selected provider model pull without provider-specific payload', () => {
    const store = TestBed.inject(HealthStore);
    apiClient.llmHealth.mockReturnValue(of(
      llmHealth({
        model: 'qwen3.5:4b',
        available: false,
        detail: 'Ollama model is missing.',
        unavailable_reason: 'model_missing',
        configured_model: 'qwen3.5:4b',
        effective_model: null,
      }),
    ));
    apiClient.runtimeRequirements.mockReturnValue(of({
      items: [
        {
          kind: 'ollama',
          label: 'Ollama',
          available: true,
          detail: 'Ollama is ready.',
          unavailable_reason: null,
        },
        {
          kind: 'ollama_model',
          label: 'Ollama model',
          available: false,
          detail: 'qwen3.5:4b is missing.',
          unavailable_reason: 'model_missing',
        },
      ],
    }));
    apiClient.startModelDownload.mockReturnValue(of(
      modelDownload({
        model: 'qwen3.5:4b',
        status: 'running',
      }),
    ));
    store.load();
    TestBed.tick();

    store.openModelDownloadConsent();
    store.confirmModelDownload();
    TestBed.tick();

    expect(apiClient.startModelDownload).toHaveBeenCalledWith();
    expect(store.modelDownload()?.model).toBe('qwen3.5:4b');
  });

  it('cancels an active model download through the generated API', () => {
    const store = TestBed.inject(HealthStore);
    apiClient.startModelDownload.mockReturnValue(of(
      modelDownload({ status: 'running', phase: 'downloading' }),
    ));
    apiClient.cancelModelDownload.mockReturnValue(of(
      modelDownload({
        status: 'canceled',
        phase: 'canceled',
        cancellable: false,
      }),
    ));
    store.load();
    TestBed.tick();
    store.openModelDownloadConsent();
    store.confirmModelDownload();
    TestBed.tick();

    store.cancelModelDownload();
    TestBed.tick();

    expect(apiClient.cancelModelDownload).toHaveBeenCalledWith('job-1');
    expect(store.modelDownload()?.phase).toBe('canceled');
    expect(store.canCancelModelDownload()).toBe(false);
  });
});
