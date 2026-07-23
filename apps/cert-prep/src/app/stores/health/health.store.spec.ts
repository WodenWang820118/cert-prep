import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import type { OCRHealthRead } from '../../contracts/api.contracts';
import { HealthStore } from './health.store';
import {
  llmHealth,
  ocrHealth,
  providerSelection,
} from './health.store.spec-helpers';
import { provideCertPrepHttpResourceClientFake } from '../../testing/cert-prep-http-resource-client.fake';

describe('HealthStore loading', () => {
  const apiClient = {
    health: vi.fn(),
    llmHealth: vi.fn(),
    llmProviderSelection: vi.fn(),
    ocrHealth: vi.fn(),
    runtimeRequirements: vi.fn(),
    startModelDownload: vi.fn(),
    getModelDownload: vi.fn(),
    startRuntimeInstallation: vi.fn(),
    getRuntimeInstallation: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.health.mockReturnValue(of({
      status: 'ok',
      app: 'cert-prep-backend',
      version: '0.1.0',
      python_version: '3.13.5',
      runtime_mode: 'source',
    }));
    apiClient.llmHealth.mockReturnValue(of(llmHealth({ available: false })));
    apiClient.llmProviderSelection.mockReturnValue(of(providerSelection()));
    apiClient.ocrHealth.mockReturnValue(of({
      ...ocrHealth(),
      fallback_reason: 'cuda_unavailable',
    }));
    apiClient.runtimeRequirements.mockReturnValue(of({ items: [] }));
    TestBed.configureTestingModule({
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        provideCertPrepHttpResourceClientFake(apiClient),
      ],
    });
  });

  it('keeps direct health results when runtime requirements are unavailable', () => {
    const store = TestBed.inject(HealthStore);
    apiClient.runtimeRequirements.mockReturnValueOnce(
      throwError(() => new Error('runtime requirements unavailable')),
    );

    store.load();
    TestBed.tick();

    expect(store.systemHealth()?.status).toBe('ok');
    expect(store.ocrHealth()?.available).toBe(true);
    expect(store.llmHealth()?.provider).toBe('ollama');
    expect(store.runtimeRequirements()).toEqual([]);
  });

  it('loads backend-owned provider selection and derives the selected runtime truth', () => {
    const store = TestBed.inject(HealthStore);
    apiClient.runtimeRequirements.mockReturnValue(of({
      items: [
        {
          kind: 'ollama',
          label: 'Ollama',
          available: false,
          detail: 'Ollama is not installed.',
          unavailable_reason: 'ollama_missing',
        },
      ],
    }));

    store.load();
    TestBed.tick();

    expect(store.providerSelection()?.preference).toBe('auto');
    expect(store.selectedProviderLabel()).toBe('Ollama');
    expect(store.configuredModelName()).toBe('qwen3.5:4b');
    expect(store.isOllamaMissing()).toBe(true);
    expect(store.canInstallOllama()).toBe(true);
  });

  it('keeps core health when provider selection is temporarily unavailable', () => {
    const store = TestBed.inject(HealthStore);
    apiClient.llmProviderSelection.mockReturnValueOnce(
      throwError(() => new Error('provider selection unavailable')),
    );

    store.load();
    TestBed.tick();

    expect(store.systemHealth()?.status).toBe('ok');
    expect(store.ocrHealth()?.available).toBe(true);
    expect(store.providerSelection()).toBeNull();
  });

  it('keeps available runtime health when optional LLM health fails', () => {
    const store = TestBed.inject(HealthStore);
    apiClient.llmHealth.mockReturnValueOnce(
      throwError(() => new Error('ollama unavailable')),
    );

    store.load();
    TestBed.tick();

    expect(store.systemHealth()?.status).toBe('ok');
    expect(store.ocrHealth()?.available).toBe(true);
    expect(store.llmHealth()).toBeNull();
    expect(store.runtimeRequirements()).toEqual([]);
  });

  it('marks OCR health as loading while the snapshot is still settling', () => {
    const store = TestBed.inject(HealthStore);
    const ocrHealthResult = new Subject<OCRHealthRead>();
    apiClient.ocrHealth.mockReturnValueOnce(ocrHealthResult);

    store.load();
    TestBed.tick();

    expect(store.healthSnapshotLoading()).toBe(true);
    expect(store.isOcrHealthLoading()).toBe(true);
    expect(store.ocrPhase()).toBe('checking');
    expect(store.ocrHealth()).toBeNull();

    ocrHealthResult.next(ocrHealth());
    ocrHealthResult.complete();
    TestBed.tick();

    expect(store.healthSnapshotLoading()).toBe(false);
    expect(store.isOcrHealthLoading()).toBe(false);
    expect(store.ocrPhase()).toBe('ready');
    expect(store.ocrHealth()?.available).toBe(true);
  });

  it('applies OCR health before slower LLM health settles', () => {
    const store = TestBed.inject(HealthStore);
    const llmHealthResult = new Subject<ReturnType<typeof llmHealth>>();
    apiClient.llmHealth.mockReturnValueOnce(llmHealthResult);

    store.load();
    TestBed.tick();

    expect(store.healthSnapshotLoading()).toBe(true);
    expect(store.ocrHealth()?.available).toBe(true);
    expect(store.isOcrHealthLoading()).toBe(false);
    expect(store.ocrPhase()).toBe('ready');

    llmHealthResult.next(llmHealth({ available: false }));
    llmHealthResult.complete();
    TestBed.tick();

    expect(store.healthSnapshotLoading()).toBe(false);
  });

  it('marks existing OCR health stale when a refresh cannot update OCR', () => {
    const store = TestBed.inject(HealthStore);
    store.ocrHealth.set(ocrHealth());
    apiClient.ocrHealth.mockReturnValueOnce(
      throwError(() => new Error('ocr unavailable')),
    );

    store.load();
    TestBed.tick();

    expect(store.ocrHealth()?.available).toBe(true);
    expect(store.ocrPhase()).toBe('stale');
    expect(store.isOcrHealthLoading()).toBe(false);
  });

  it('marks OCR failed when the first OCR health check fails', () => {
    const store = TestBed.inject(HealthStore);
    apiClient.ocrHealth.mockReturnValueOnce(
      throwError(() => new Error('ocr unavailable')),
    );

    store.load();
    TestBed.tick();

    expect(store.ocrHealth()).toBeNull();
    expect(store.ocrPhase()).toBe('failed');
    expect(store.isOcrHealthLoading()).toBe(false);
  });
});
