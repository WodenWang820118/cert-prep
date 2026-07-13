import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import { HealthStore } from './health.store';
import {
  llmHealth,
  ocrHealth,
  runtimeInstallation,
} from './health.store.spec-helpers';

describe('HealthStore runtime installation', () => {
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
      app: 'cert-prep-backend',
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
      providers: [{ provide: CERT_PREP_API, useValue: apiClient }],
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
    await store.load();

    store.openOcrRuntimeInstallConsent();
    await store.confirmRuntimeInstallation();

    expect(apiClient.startRuntimeInstallation).toHaveBeenCalledWith(
      'windowsml_ocr',
    );
    expect(store.runtimeInstall()?.kind).toBe('windowsml_ocr');
    expect(store.runtimeInstall()?.label).toBe('WindowsML OCR runtime');
  });

  it('blocks FastFlowLM installation until terms are accepted', async () => {
    const store = TestBed.inject(HealthStore);
    apiClient.llmHealth.mockResolvedValue(
      llmHealth({
        provider: 'fastflowlm',
        model: 'qwen3.5:4b',
        available: false,
        detail: 'FastFlowLM setup is required.',
        unavailable_reason: 'fastflowlm_missing',
      }),
    );
    apiClient.runtimeRequirements.mockResolvedValue({
      items: [
        fastFlowRuntimeMissingRequirement('fastflowlm_terms_required'),
      ],
    });
    apiClient.startRuntimeInstallation.mockResolvedValue(
      runtimeInstallation({
        kind: 'fastflowlm',
        provider: 'fastflowlm',
        model: 'fastflowlm',
        status: 'succeeded',
        detail: 'FastFlowLM installation completed',
        completed: 100,
      }),
    );
    await store.load();

    store.openFastFlowInstallConsent();

    expect(store.runtimeInstallConsentVisible()).toBe(false);
    expect(apiClient.startRuntimeInstallation).not.toHaveBeenCalled();

    apiClient.runtimeRequirements.mockResolvedValueOnce({
      items: [fastFlowRuntimeMissingRequirement('fastflowlm_missing')],
    });
    await store.load();
    store.openFastFlowInstallConsent();

    apiClient.llmHealth.mockResolvedValueOnce(fastFlowNotRunningHealth());
    apiClient.runtimeRequirements.mockResolvedValueOnce({
      items: [
        fastFlowRuntimeAvailableRequirement(),
        fastFlowModelRequirement('model_missing'),
      ],
    });
    await store.confirmRuntimeInstallation();

    expect(apiClient.startRuntimeInstallation).toHaveBeenCalledWith(
      'fastflowlm',
    );
    expect(store.runtimeInstallConsentVisible()).toBe(false);
    expect(store.runtimeInstall()?.kind).toBe('fastflowlm');
    expect(store.runtimeInstall()?.label).toBe('FastFlowLM');
    await vi.waitFor(() =>
      expect(store.modelDownloadConsentVisible()).toBe(true),
    );
  });

  it('does not chain a stale runtime-success refresh into model consent', async () => {
    const store = TestBed.inject(HealthStore);
    let resolveRuntimeRefreshRequirements!: (value: {
      items: unknown[];
    }) => void;
    apiClient.llmHealth.mockResolvedValue(
      llmHealth({
        provider: 'fastflowlm',
        model: 'qwen3.5:4b',
        available: false,
        detail: 'FastFlowLM is not installed.',
        unavailable_reason: 'fastflowlm_missing',
      }),
    );
    apiClient.runtimeRequirements.mockResolvedValueOnce({
      items: [fastFlowRuntimeMissingRequirement('fastflowlm_missing')],
    });
    apiClient.startRuntimeInstallation.mockResolvedValue(
      runtimeInstallation({
        kind: 'fastflowlm',
        provider: 'fastflowlm',
        model: 'fastflowlm',
        status: 'succeeded',
        detail: 'FastFlowLM installation completed',
        completed: 100,
      }),
    );
    await store.load();
    store.openFastFlowInstallConsent();

    apiClient.llmHealth.mockResolvedValue(fastFlowNotRunningHealth());
    apiClient.runtimeRequirements
      .mockReturnValueOnce(
        new Promise<{ items: unknown[] }>((resolve) => {
          resolveRuntimeRefreshRequirements = resolve;
        }),
      )
      .mockResolvedValueOnce({
        items: [
          fastFlowRuntimeAvailableRequirement(),
          fastFlowModelRequirement('model_missing'),
        ],
      });

    let confirmationSettled = false;
    const confirmation = store.confirmRuntimeInstallation().finally(() => {
      confirmationSettled = true;
    });
    await vi.waitFor(() => {
      expect(apiClient.runtimeRequirements).toHaveBeenCalledTimes(2);
    });
    await expect(store.load()).resolves.toBe(true);
    expect(store.runtimeInstallStarting()).toBe(false);
    expect(confirmationSettled).toBe(false);
    resolveRuntimeRefreshRequirements({
      items: [
        fastFlowRuntimeAvailableRequirement(),
        fastFlowModelRequirement('model_missing'),
      ],
    });
    await confirmation;

    expect(confirmationSettled).toBe(true);
    expect(store.modelDownloadConsentVisible()).toBe(false);
    expect(store.canDownloadModel()).toBe(true);
  });
});

function fastFlowRuntimeMissingRequirement(unavailableReason: string) {
  return {
    kind: 'fastflowlm',
    label: 'FastFlowLM',
    available: false,
    detail: 'FastFlowLM setup is required.',
    unavailable_reason: unavailableReason,
    version: '0.9.43',
    bytes: 18_577_840,
    installed_path: null,
  };
}

function fastFlowRuntimeAvailableRequirement() {
  return {
    ...fastFlowRuntimeMissingRequirement('fastflowlm_missing'),
    available: true,
    detail: 'FastFlowLM 0.9.43 is installed.',
    unavailable_reason: null,
    installed_path: 'C:\\Program Files\\flm\\flm.exe',
  };
}

function fastFlowModelRequirement(unavailableReason: string) {
  return {
    kind: 'fastflowlm_model',
    label: 'FastFlowLM model',
    available: false,
    detail: 'FastFlowLM model qwen3.5:4b is not installed.',
    unavailable_reason: unavailableReason,
    version: 'qwen3.5:4b',
    bytes: null,
    installed_path: null,
  };
}

function fastFlowNotRunningHealth() {
  return llmHealth({
    provider: 'fastflowlm',
    model: 'qwen3.5:4b',
    available: false,
    detail: 'FastFlowLM server is not running.',
    unavailable_reason: 'fastflowlm_not_running',
    configured_model: 'qwen3.5:4b',
    effective_model: null,
    fallback_models: ['qwen3.5:2b'],
    fallback_reason: null,
  });
}
