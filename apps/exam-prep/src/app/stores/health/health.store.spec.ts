import { TestBed } from '@angular/core/testing';
import {
  EXAM_PREP_API,
  LLMHealthRead,
  ModelDownloadRead,
  RuntimeInstallationRead,
} from '../../exam-prep-api';
import { HealthStore } from './health.store';

describe('HealthStore model downloads', () => {
  const apiClient = {
    health: vi.fn(),
    llmHealth: vi.fn(),
    ocrHealth: vi.fn(),
    runtimeRequirements: vi.fn(),
    startModelDownload: vi.fn(),
    getModelDownload: vi.fn(),
    startRuntimeInstallation: vi.fn(),
    getRuntimeInstallation: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    apiClient.health.mockResolvedValue({
      status: 'ok',
      app: 'exam-prep-backend',
      version: '0.1.0',
      python_version: '3.13.5',
      runtime_mode: 'source',
    });
    apiClient.llmHealth.mockResolvedValue(llmHealth({ available: false }));
    apiClient.ocrHealth.mockResolvedValue({
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
      fallback_reason: 'cuda_unavailable',
      unavailable_reason: null,
    });
    apiClient.runtimeRequirements.mockResolvedValue({ items: [] });
    TestBed.configureTestingModule({
      providers: [{ provide: EXAM_PREP_API, useValue: apiClient }],
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

  it('keeps direct health results when runtime requirements are unavailable', async () => {
    const store = TestBed.inject(HealthStore);
    apiClient.runtimeRequirements.mockRejectedValueOnce(
      new Error('runtime requirements unavailable'),
    );

    await store.load();

    expect(store.systemHealth()?.status).toBe('ok');
    expect(store.ocrHealth()?.available).toBe(true);
    expect(store.llmHealth()?.provider).toBe('ollama');
    expect(store.runtimeRequirements()).toEqual([]);
  });

  it('keeps available runtime health when optional LLM health fails', async () => {
    const store = TestBed.inject(HealthStore);
    apiClient.llmHealth.mockRejectedValueOnce(new Error('ollama unavailable'));

    await store.load();

    expect(store.systemHealth()?.status).toBe('ok');
    expect(store.ocrHealth()?.available).toBe(true);
    expect(store.llmHealth()).toBeNull();
    expect(store.runtimeRequirements()).toEqual([]);
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

  it('starts and polls a runtime installation after confirmation', async () => {
    const store = TestBed.inject(HealthStore);
    apiClient.llmHealth.mockResolvedValue(
      llmHealth({
        available: false,
        detail: 'Ollama is not installed.',
        unavailable_reason: 'ollama_missing',
      }),
    );
    apiClient.startRuntimeInstallation.mockResolvedValue(
      runtimeInstallation({
        status: 'running',
        detail: 'Installing Ollama',
        completed: 10,
      }),
    );
    apiClient.getRuntimeInstallation.mockResolvedValue(
      runtimeInstallation({
        status: 'succeeded',
        detail: 'Ollama installation completed',
        completed: 100,
      }),
    );
    await store.load();

    store.openOllamaInstallConsent();
    await store.confirmRuntimeInstallation();

    expect(apiClient.startRuntimeInstallation).toHaveBeenCalledWith('ollama');
    expect(store.runtimeInstallConsentVisible()).toBe(false);
    expect(store.runtimeInstall()?.phase).toBe('running');
    expect(store.runtimeInstall()?.progress).toBe(10);

    apiClient.llmHealth.mockResolvedValue(
      llmHealth({
        available: true,
        detail: 'Ollama is ready.',
        unavailable_reason: null,
      }),
    );
    await vi.advanceTimersByTimeAsync(1500);

    expect(apiClient.getRuntimeInstallation).toHaveBeenCalledWith('runtime-1');
    expect(store.runtimeInstall()?.phase).toBe('succeeded');
    expect(store.runtimeInstall()?.progress).toBe(100);
    await vi.waitFor(() => expect(store.llmHealth()?.available).toBe(true));
    expect(apiClient.health).toHaveBeenCalledTimes(2);
    expect(apiClient.runtimeRequirements).toHaveBeenCalledTimes(2);
  });
});

function llmHealth(overrides: Partial<LLMHealthRead> = {}): LLMHealthRead {
  return {
    provider: 'ollama',
    model: 'reasoner:7b',
    available: false,
    detail: 'model not found',
    unavailable_reason: 'model_missing',
    ...overrides,
  };
}

function modelDownload(
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

function runtimeInstallation(
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
