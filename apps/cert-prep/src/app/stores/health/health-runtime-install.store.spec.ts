import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import { HealthStore } from './health.store';
import {
  llmHealth,
  ocrHealth,
  providerSelection,
  runtimeInstallation,
} from './health.store.spec-helpers';
import { provideCertPrepHttpResourceClientFake } from '../../testing/cert-prep-http-resource-client.fake';

describe('HealthStore runtime installation', () => {
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
    cancelRuntimeInstallation: vi.fn(),
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
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        provideCertPrepHttpResourceClientFake(apiClient),
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    store.load();
    await vi.waitFor(() => expect(store.healthSnapshotLoading()).toBe(false));

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

  it('starts WindowsML OCR runtime installation from WindowsML missing health', async () => {
    const store = TestBed.inject(HealthStore);
    apiClient.ocrHealth.mockResolvedValue({
      ...ocrHealth(),
      provider: 'windowsml',
      engine: 'onnxruntime-windowsml',
      available: false,
      detail: 'WindowsML OCR runtime is not installed.',
      selected_device: null,
      unavailable_reason: 'windowsml_runtime_missing',
    });
    apiClient.startRuntimeInstallation.mockResolvedValue(
      runtimeInstallation({
        kind: 'windowsml_ocr',
        provider: 'windowsml',
        model: 'pp-ocrv5-windowsml',
        status: 'running',
        detail: 'Installing WindowsML OCR runtime',
        completed: 10,
      }),
    );
    store.load();
    await vi.waitFor(() => expect(store.healthSnapshotLoading()).toBe(false));

    store.openOcrRuntimeInstallConsent();
    await store.confirmRuntimeInstallation();

    expect(apiClient.startRuntimeInstallation).toHaveBeenCalledWith(
      'windowsml_ocr',
    );
    expect(store.runtimeInstall()?.kind).toBe('windowsml_ocr');
    expect(store.runtimeInstall()?.label).toBe('WindowsML OCR runtime');
  });

  it('downloads the consent-gated Whisper model bundle through runtime installation', async () => {
    const store = TestBed.inject(HealthStore);
    apiClient.runtimeRequirements.mockResolvedValue({
      items: [
        {
          kind: 'whisper_models',
          label: 'Whisper speech models',
          available: false,
          detail: 'Whisper speech models require download.',
          unavailable_reason: 'whisper_models_missing',
          version: 'large-v3-turbo + small',
        },
      ],
    });
    apiClient.startRuntimeInstallation.mockResolvedValue(
      runtimeInstallation({
        kind: 'whisper_models',
        provider: 'faster-whisper',
        model: 'large-v3-turbo + small',
        status: 'running',
        phase: 'model_download',
        detail: 'Downloading Whisper small.',
        completed: 25,
        total: 100,
      }),
    );
    store.load();
    await vi.waitFor(() => expect(store.healthSnapshotLoading()).toBe(false));

    store.openWhisperModelsConsent();
    await store.confirmRuntimeInstallation();

    expect(apiClient.startRuntimeInstallation).toHaveBeenCalledWith(
      'whisper_models',
    );
    expect(store.runtimeInstall()?.kind).toBe('whisper_models');
    expect(store.runtimeInstall()?.label).toBe('Whisper speech models');
    expect(store.runtimeInstall()?.progress).toBe(25);
  });

  it('cancels an active runtime installation through the generated API', async () => {
    const store = TestBed.inject(HealthStore);
    apiClient.llmHealth.mockResolvedValue(
      llmHealth({
        available: false,
        detail: 'Ollama is not installed.',
        unavailable_reason: 'ollama_missing',
      }),
    );
    apiClient.startRuntimeInstallation.mockResolvedValue(
      runtimeInstallation({ status: 'running', phase: 'installing' }),
    );
    apiClient.cancelRuntimeInstallation.mockResolvedValue(
      runtimeInstallation({
        status: 'canceled',
        phase: 'canceled',
        cancellable: false,
      }),
    );
    store.load();
    await vi.waitFor(() => expect(store.healthSnapshotLoading()).toBe(false));
    store.openOllamaInstallConsent();
    await store.confirmRuntimeInstallation();

    await store.cancelRuntimeInstallation();

    expect(apiClient.cancelRuntimeInstallation).toHaveBeenCalledWith(
      'runtime-1',
    );
    expect(store.runtimeInstall()?.phase).toBe('canceled');
    expect(store.canCancelRuntimeInstallation()).toBe(false);
  });
});
