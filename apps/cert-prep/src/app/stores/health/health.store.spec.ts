import { TestBed } from '@angular/core/testing';
import {
  CERT_PREP_API,
  HealthResponse,
  LLMHealthRead,
  OCRHealthRead,
  RuntimeRequirementRead,
} from '../../cert-prep-api';
import { OperationStore } from '../operation.store';
import { HealthStore } from './health.store';
import { llmHealth, ocrHealth } from './health.store.spec-helpers';

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
    apiClient.ocrHealth.mockResolvedValue({
      ...ocrHealth(),
      fallback_reason: 'cuda_unavailable',
    });
    apiClient.runtimeRequirements.mockResolvedValue({ items: [] });
    apiClient.llmProviderSelection.mockResolvedValue(fastFlowSelection());
    apiClient.decideFastflowlmTerms.mockResolvedValue(
      fastFlowSelection({ terms_accepted: true }),
    );
    TestBed.configureTestingModule({
      providers: [{ provide: CERT_PREP_API, useValue: apiClient }],
    });
  });

  it('keeps direct health results but fails closed when runtime requirements are unavailable', async () => {
    const store = TestBed.inject(HealthStore);
    apiClient.llmHealth.mockResolvedValue(
      llmHealth({
        provider: 'fastflowlm',
        unavailable_reason: 'fastflowlm_missing',
      }),
    );
    apiClient.runtimeRequirements.mockResolvedValueOnce({
      items: [fastFlowRuntimeRequirement(false, 'fastflowlm_missing')],
    });

    await store.load();

    expect(store.canInstallFastFlow()).toBe(true);

    apiClient.runtimeRequirements.mockRejectedValueOnce(
      new Error('runtime requirements unavailable'),
    );

    await store.load();

    expect(store.systemHealth()?.status).toBe('ok');
    expect(store.ocrHealth()?.available).toBe(true);
    expect(store.llmHealth()?.provider).toBe('fastflowlm');
    expect(store.runtimeRequirements()).toEqual([]);
    expect(store.canInstallFastFlow()).toBe(false);
    expect(store.canReviewFastFlowTerms()).toBe(false);
    expect(store.canDownloadModel()).toBe(false);
  });

  it('ignores a stale runtime-requirement response from an older load', async () => {
    const store = TestBed.inject(HealthStore);
    let resolveOldRequirements!: (value: {
      items: RuntimeRequirementRead[];
    }) => void;
    apiClient.llmHealth.mockResolvedValue(
      llmHealth({
        provider: 'fastflowlm',
        unavailable_reason: 'fastflowlm_not_running',
      }),
    );
    apiClient.runtimeRequirements
      .mockReturnValueOnce(
        new Promise<{ items: RuntimeRequirementRead[] }>((resolve) => {
          resolveOldRequirements = resolve;
        }),
      )
      .mockResolvedValueOnce({
        items: [
          fastFlowRuntimeRequirement(true, null),
          fastFlowModelRequirement('fastflowlm_terms_required'),
        ],
      });

    const oldLoad = store.load();
    const currentLoad = store.load();
    await expect(currentLoad).resolves.toBe(true);

    expect(store.isFastFlowTermsRequired()).toBe(true);
    expect(store.canInstallFastFlow()).toBe(false);
    expect(store.healthSnapshotLoading()).toBe(false);

    resolveOldRequirements({
      items: [fastFlowRuntimeRequirement(false, 'fastflowlm_missing')],
    });
    await expect(oldLoad).resolves.toBe(false);

    expect(store.isFastFlowTermsRequired()).toBe(true);
    expect(store.canInstallFastFlow()).toBe(false);
    expect(store.isFastFlowRuntimeAvailable()).toBe(true);
  });

  it('does not leak a stale refresh failure after a newer load succeeds', async () => {
    const store = TestBed.inject(HealthStore);
    const operations = TestBed.inject(OperationStore);
    const oldSystem = pendingRejection<HealthResponse>();
    const oldLlm = pendingRejection<LLMHealthRead>();
    const oldOcr = pendingRejection<OCRHealthRead>();
    apiClient.health.mockReturnValueOnce(oldSystem.promise);
    apiClient.llmHealth.mockReturnValueOnce(oldLlm.promise);
    apiClient.ocrHealth.mockReturnValueOnce(oldOcr.promise);

    const oldRefresh = store.refresh();
    await store.load();

    expect(store.healthSnapshotLoading()).toBe(false);
    expect(store.systemHealth()?.status).toBe('ok');
    expect(operations.busy()).toBe('health');

    oldSystem.reject(new Error('stale system failure'));
    oldLlm.reject(new Error('stale llm failure'));
    oldOcr.reject(new Error('stale ocr failure'));
    await oldRefresh;

    expect(store.systemHealth()?.status).toBe('ok');
    expect(operations.error()).toBeNull();
    expect(operations.busy()).toBeNull();
    expect(store.healthSnapshotLoading()).toBe(false);
  });

  it('keeps terms consent open when its health refresh is superseded', async () => {
    const store = TestBed.inject(HealthStore);
    const operations = TestBed.inject(OperationStore);
    let resolveDecisionRequirements!: (value: {
      items: RuntimeRequirementRead[];
    }) => void;
    store.runtimeRequirements.set([
      fastFlowRuntimeRequirement(true, null),
      fastFlowModelRequirement('fastflowlm_terms_required'),
    ]);
    apiClient.llmHealth.mockResolvedValue(
      llmHealth({
        provider: 'fastflowlm',
        unavailable_reason: 'fastflowlm_not_running',
      }),
    );
    apiClient.runtimeRequirements
      .mockReturnValueOnce(
        new Promise<{ items: RuntimeRequirementRead[] }>((resolve) => {
          resolveDecisionRequirements = resolve;
        }),
      )
      .mockResolvedValueOnce({
        items: [
          fastFlowRuntimeRequirement(true, null),
          fastFlowModelRequirement('model_missing'),
        ],
      });

    await store.openFastFlowTermsConsent();
    store.setFastFlowTermsAcknowledged(true);
    const acceptance = store.acceptFastFlowTerms();
    await vi.waitFor(() => {
      expect(apiClient.runtimeRequirements).toHaveBeenCalledOnce();
    });

    await expect(store.load()).resolves.toBe(true);
    resolveDecisionRequirements({
      items: [
        fastFlowRuntimeRequirement(true, null),
        fastFlowModelRequirement('model_missing'),
      ],
    });
    await acceptance;

    expect(store.fastFlowTermsConsentVisible()).toBe(true);
    expect(store.fastFlowTermsAcknowledged()).toBe(true);
    expect(store.modelDownloadConsentVisible()).toBe(false);
    expect(operations.error()).toContain('changed during onboarding');
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

function fastFlowRuntimeRequirement(
  available: boolean,
  unavailableReason: string | null,
): RuntimeRequirementRead {
  return {
    kind: 'fastflowlm',
    label: 'FastFlowLM',
    available,
    detail: available ? 'FastFlowLM is installed.' : 'FastFlowLM is missing.',
    unavailable_reason: unavailableReason,
  };
}

function fastFlowModelRequirement(
  unavailableReason: string,
): RuntimeRequirementRead {
  return {
    kind: 'fastflowlm_model',
    label: 'FastFlowLM model',
    available: false,
    detail: 'FastFlowLM model onboarding is required.',
    unavailable_reason: unavailableReason,
  };
}

function pendingRejection<T>(): {
  promise: Promise<T>;
  reject: (reason: unknown) => void;
} {
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

function fastFlowSelection(
  overrides: Record<string, unknown> = {},
) {
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
    terms_url:
      'https://raw.githubusercontent.com/FastFlowLM/FastFlowLM/v0.9.43/src/inno/terms.txt',
    runtime_requirement_kind: 'fastflowlm',
    model_requirement_kind: 'fastflowlm_model',
    ...overrides,
  };
}
