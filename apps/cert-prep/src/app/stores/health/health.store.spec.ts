import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API, OCRHealthRead } from '../../cert-prep-api';
import { HealthStore } from './health.store';
import {
  llmHealth,
  ocrHealth,
  providerSelection,
} from './health.store.spec-helpers';

describe('HealthStore loading', () => {
  const apiClient = {
    health: vi.fn(),
    llmHealth: vi.fn(),
    llmProviderSelection: vi.fn(),
    decideFastflowlmTerms: vi.fn(),
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
      app: 'cert-prep-backend',
      version: '0.1.0',
      python_version: '3.13.5',
      runtime_mode: 'source',
    });
    apiClient.llmHealth.mockResolvedValue(llmHealth({ available: false }));
    apiClient.llmProviderSelection.mockResolvedValue(providerSelection());
    apiClient.ocrHealth.mockResolvedValue({
      ...ocrHealth(),
      fallback_reason: 'cuda_unavailable',
    });
    apiClient.runtimeRequirements.mockResolvedValue({ items: [] });
    TestBed.configureTestingModule({
      providers: [{ provide: CERT_PREP_API, useValue: apiClient }],
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

  it('loads backend-owned provider selection and derives the selected runtime truth', async () => {
    const store = TestBed.inject(HealthStore);
    apiClient.runtimeRequirements.mockResolvedValueOnce({
      items: [
        {
          kind: 'fastflowlm',
          label: 'FastFlowLM',
          available: false,
          detail: 'FastFlowLM is not installed.',
          unavailable_reason: 'fastflowlm_missing',
        },
      ],
    });

    await store.load();

    expect(store.providerSelection()?.preference).toBe('auto');
    expect(store.selectedProviderLabel()).toBe('FastFlowLM');
    expect(store.configuredModelName()).toBe('qwen3.5:4b');
    expect(store.isFastFlowRuntimeMissing()).toBe(true);
    expect(store.canInstallFastFlow()).toBe(true);
  });

  it('keeps core health when provider selection is temporarily unavailable', async () => {
    const store = TestBed.inject(HealthStore);
    apiClient.llmProviderSelection.mockRejectedValueOnce(
      new Error('provider selection unavailable'),
    );

    await store.load();

    expect(store.systemHealth()?.status).toBe('ok');
    expect(store.ocrHealth()?.available).toBe(true);
    expect(store.providerSelection()).toBeNull();
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
    expect(store.ocrPhase()).toBe('checking');
    expect(store.ocrHealth()).toBeNull();

    resolveOcrHealth(ocrHealth());
    await load;

    expect(store.healthSnapshotLoading()).toBe(false);
    expect(store.isOcrHealthLoading()).toBe(false);
    expect(store.ocrPhase()).toBe('ready');
    expect(store.ocrHealth()?.available).toBe(true);
  });

  it('applies OCR health before slower LLM health settles', async () => {
    const store = TestBed.inject(HealthStore);
    let resolveLlmHealth!: (value: ReturnType<typeof llmHealth>) => void;
    apiClient.llmHealth.mockReturnValueOnce(
      new Promise<ReturnType<typeof llmHealth>>((resolve) => {
        resolveLlmHealth = resolve;
      }),
    );

    const load = store.load();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.healthSnapshotLoading()).toBe(true);
    expect(store.ocrHealth()?.available).toBe(true);
    expect(store.isOcrHealthLoading()).toBe(false);
    expect(store.ocrPhase()).toBe('ready');

    resolveLlmHealth(llmHealth({ available: false }));
    await load;

    expect(store.healthSnapshotLoading()).toBe(false);
  });

  it('marks existing OCR health stale when a refresh cannot update OCR', async () => {
    const store = TestBed.inject(HealthStore);
    store.ocrHealth.set(ocrHealth());
    apiClient.ocrHealth.mockRejectedValueOnce(new Error('ocr unavailable'));

    await store.load();

    expect(store.ocrHealth()?.available).toBe(true);
    expect(store.ocrPhase()).toBe('stale');
    expect(store.isOcrHealthLoading()).toBe(false);
  });

  it('marks OCR failed when the first OCR health check fails', async () => {
    const store = TestBed.inject(HealthStore);
    apiClient.ocrHealth.mockRejectedValueOnce(new Error('ocr unavailable'));

    await store.load();

    expect(store.ocrHealth()).toBeNull();
    expect(store.ocrPhase()).toBe('failed');
    expect(store.isOcrHealthLoading()).toBe(false);
  });
});
