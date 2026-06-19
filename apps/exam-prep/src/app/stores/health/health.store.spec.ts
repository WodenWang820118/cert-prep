import { TestBed } from '@angular/core/testing';
import { EXAM_PREP_API, OCRHealthRead } from '../../exam-prep-api';
import { HealthStore } from './health.store';
import { llmHealth, ocrHealth } from './health.store.spec-helpers';

describe('HealthStore loading', () => {
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
      ...ocrHealth(),
      fallback_reason: 'cuda_unavailable',
    });
    apiClient.runtimeRequirements.mockResolvedValue({ items: [] });
    TestBed.configureTestingModule({
      providers: [{ provide: EXAM_PREP_API, useValue: apiClient }],
    });
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

  it('marks OCR health as loading while the snapshot is still settling', async () => {
    const store = TestBed.inject(HealthStore);
    let resolveOcrHealth!: (value: OCRHealthRead) => void;
    apiClient.ocrHealth.mockReturnValueOnce(
      new Promise<OCRHealthRead>((resolve) => {
        resolveOcrHealth = resolve;
      }),
    );

    const load = store.load();

    expect(store.healthSnapshotLoading()).toBe(true);
    expect(store.isOcrHealthLoading()).toBe(true);
    expect(store.ocrHealth()).toBeNull();

    resolveOcrHealth(ocrHealth());
    await load;

    expect(store.healthSnapshotLoading()).toBe(false);
    expect(store.isOcrHealthLoading()).toBe(false);
    expect(store.ocrHealth()?.available).toBe(true);
  });
});
