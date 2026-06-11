import { TestBed } from '@angular/core/testing';
import { EXAM_PREP_API, LLMHealthRead, ModelDownloadRead } from '../exam-prep-api';
import { HealthStore } from './health.store';

describe('HealthStore model downloads', () => {
  const apiClient = {
    llmHealth: vi.fn(),
    ocrHealth: vi.fn(),
    startModelDownload: vi.fn(),
    getModelDownload: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
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
    });
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
});

function llmHealth(overrides: Partial<LLMHealthRead> = {}): LLMHealthRead {
  return {
    provider: 'ollama',
    model: 'gemma4:12b',
    available: false,
    detail: 'model not found',
    ...overrides,
  };
}

function modelDownload(
  overrides: Partial<ModelDownloadRead> = {},
): ModelDownloadRead {
  return {
    id: 'job-1',
    provider: 'ollama',
    model: 'gemma4:12b',
    status: 'running',
    detail: 'downloading',
    completed: 25,
    total: 100,
    created_at: '2026-06-11T00:00:00Z',
    updated_at: '2026-06-11T00:00:00Z',
    ...overrides,
  };
}
