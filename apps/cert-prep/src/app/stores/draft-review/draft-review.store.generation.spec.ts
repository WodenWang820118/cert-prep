import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API, LLMHealthRead } from '../../cert-prep-api';
import { DraftReviewStore } from './draft-review.store';
import { ProjectStore } from '../project.store';
import { SourceImportStore } from '../source-import/source-import.store';
import { HealthStore } from '../health/health.store';
import { documentRead, questionDraft } from './draft-review.store.spec-helpers';

const FASTFLOW_TERMS_URL =
  'https://raw.githubusercontent.com/FastFlowLM/FastFlowLM/v0.9.43/src/inno/terms.txt';

describe('DraftReviewStore generation', () => {
  const apiClient = {
    generateDocumentDrafts: vi.fn(),
    getDocument: vi.fn(),
    getModelDownload: vi.fn(),
    getRuntimeInstallation: vi.fn(),
    health: vi.fn(),
    llmHealth: vi.fn(),
    llmProviderSelection: vi.fn(),
    decideFastflowlmTerms: vi.fn(),
    listDocumentChunks: vi.fn(),
    listDocumentDraftJobs: vi.fn(),
    listQuestionDrafts: vi.fn(),
    retryDocumentDraftJobs: vi.fn(),
    ocrHealth: vi.fn(),
    runtimeRequirements: vi.fn(),
    startModelDownload: vi.fn(),
    startRuntimeInstallation: vi.fn(),
    updateQuestionDraft: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [{ provide: CERT_PREP_API, useValue: apiClient }],
    });

    const projects = TestBed.inject(ProjectStore);
    projects.projects.set([
      {
        id: 'project-1',
        name: 'JLPT N1',
        description: '',
        created_at: '2026-06-09T00:00:00Z',
        updated_at: '2026-06-09T00:00:00Z',
      },
    ]);
    projects.select('project-1');

    apiClient.getDocument.mockResolvedValue(documentRead());
    apiClient.listDocumentChunks.mockResolvedValue({ items: [] });
    apiClient.listDocumentDraftJobs.mockResolvedValue({ items: [] });
    apiClient.health.mockResolvedValue({
      status: 'ok',
      app: 'cert-prep-backend',
      version: '0.1.0',
      python_version: '3.13.5',
      runtime_mode: 'source',
    });
    apiClient.ocrHealth.mockResolvedValue({
      provider: 'paddle',
      engine: 'paddleocr',
      available: true,
      detail: 'Ready',
      python_version: '3.13.5',
      paddle_version: null,
      paddleocr_version: null,
      selected_device: 'cpu',
      cuda_available: false,
      gpu_count: 0,
      model_cache_dir: null,
      fallback_reason: null,
      unavailable_reason: null,
    });
  });

  it('sends deterministic strategy when generating deterministic questions', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const draft = questionDraft();
    activateDocument(sourceImport, documentRead());
    apiClient.generateDocumentDrafts.mockResolvedValue({ items: [draft] });
    apiClient.listQuestionDrafts.mockResolvedValue({ items: [draft] });

    await store.generateDrafts('deterministic_only');

    expect(apiClient.generateDocumentDrafts).toHaveBeenCalledWith(
      'project-1',
      'document-1',
      { limit: 3, strategy: 'deterministic_only' },
    );
    expect(apiClient.listDocumentDraftJobs).toHaveBeenCalledWith(
      'project-1',
      'document-1',
    );
  });

  it('sends hybrid reasoning strategy when generating questions', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const draft = questionDraft();
    store.setQuestionLimit(8);
    activateDocument(sourceImport, documentRead());
    apiClient.generateDocumentDrafts.mockResolvedValue({ items: [draft] });
    apiClient.listQuestionDrafts.mockResolvedValue({ items: [draft] });

    await store.generateDrafts('hybrid_reasoning');

    expect(apiClient.generateDocumentDrafts).toHaveBeenCalledWith(
      'project-1',
      'document-1',
      { limit: 8, strategy: 'hybrid_reasoning' },
    );
    expect(apiClient.listDocumentDraftJobs).toHaveBeenCalledWith(
      'project-1',
      'document-1',
    );
  });

  it('opens FastFlowLM terms from the normal generation flow', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const health = TestBed.inject(HealthStore);
    activateDocument(sourceImport, documentRead());
    apiClient.generateDocumentDrafts.mockRejectedValue({
      error: {
        code: 'provider_unavailable',
        message: 'FastFlowLM onboarding is required.',
      },
    });
    apiClient.llmHealth.mockResolvedValue(
      fastFlowLlmHealth({ unavailable_reason: 'fastflowlm_not_running' }),
    );
    apiClient.runtimeRequirements.mockResolvedValue({
      items: [
        fastFlowRuntimeAvailableRequirement(),
        fastFlowModelRequirement('fastflowlm_terms_required'),
      ],
    });
    apiClient.llmProviderSelection.mockResolvedValue(fastFlowSelection());

    await store.generateDrafts('hybrid_reasoning');

    expect(apiClient.llmProviderSelection).toHaveBeenCalledOnce();
    expect(health.fastFlowTermsConsentVisible()).toBe(true);
  });

  it('opens FastFlowLM installation after accepted terms', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const health = TestBed.inject(HealthStore);
    activateDocument(sourceImport, documentRead());
    apiClient.generateDocumentDrafts.mockRejectedValue({
      error: {
        code: 'provider_unavailable',
        message: 'FastFlowLM is not installed.',
      },
    });
    apiClient.llmHealth.mockResolvedValue(fastFlowLlmHealth());
    apiClient.runtimeRequirements.mockResolvedValue({
      items: [fastFlowRequirement('fastflowlm_missing')],
    });

    await store.generateDrafts('hybrid_reasoning');

    expect(health.runtimeInstallConsentKind()).toBe('fastflowlm');
    expect(apiClient.llmProviderSelection).not.toHaveBeenCalled();
  });

  it('opens model onboarding from the real stopped FastFlowLM runtime state', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const health = TestBed.inject(HealthStore);
    activateDocument(sourceImport, documentRead());
    apiClient.generateDocumentDrafts.mockRejectedValue({
      error: {
        code: 'provider_unavailable',
        message: 'The configured FastFlowLM model is not installed.',
      },
    });
    apiClient.llmHealth.mockResolvedValue(
      fastFlowLlmHealth({ unavailable_reason: 'fastflowlm_not_running' }),
    );
    apiClient.runtimeRequirements.mockResolvedValue({
      items: [
        fastFlowRuntimeAvailableRequirement(),
        fastFlowModelRequirement('model_missing'),
      ],
    });

    await store.generateDrafts('hybrid_reasoning');

    expect(health.modelDownloadConsentVisible()).toBe(true);
    expect(health.runtimeInstallConsentKind()).toBeNull();
    expect(apiClient.llmProviderSelection).not.toHaveBeenCalled();
  });

  it('does not open a stale onboarding dialog when its health load is superseded', async () => {
    const store = TestBed.inject(DraftReviewStore);
    const sourceImport = TestBed.inject(SourceImportStore);
    const health = TestBed.inject(HealthStore);
    let resolvePromptRequirements!: (value: { items: unknown[] }) => void;
    activateDocument(sourceImport, documentRead());
    apiClient.generateDocumentDrafts.mockRejectedValue({
      error: {
        code: 'provider_unavailable',
        message: 'FastFlowLM onboarding is required.',
      },
    });
    apiClient.llmHealth.mockResolvedValue(
      fastFlowLlmHealth({ unavailable_reason: 'fastflowlm_not_running' }),
    );
    apiClient.runtimeRequirements
      .mockReturnValueOnce(
        new Promise<{ items: unknown[] }>((resolve) => {
          resolvePromptRequirements = resolve;
        }),
      )
      .mockResolvedValueOnce({
        items: [
          fastFlowRuntimeAvailableRequirement(),
          fastFlowModelRequirement('model_missing'),
        ],
      });

    const generation = store.generateDrafts('hybrid_reasoning');
    await vi.waitFor(() => {
      expect(apiClient.runtimeRequirements).toHaveBeenCalledOnce();
    });
    await expect(health.load()).resolves.toBe(true);
    resolvePromptRequirements({
      items: [
        fastFlowRuntimeAvailableRequirement(),
        fastFlowModelRequirement('fastflowlm_terms_required'),
      ],
    });
    await generation;

    expect(health.fastFlowTermsConsentVisible()).toBe(false);
    expect(health.runtimeInstallConsentVisible()).toBe(false);
    expect(health.modelDownloadConsentVisible()).toBe(false);
    expect(health.canDownloadModel()).toBe(true);
  });
});

function fastFlowLlmHealth(
  overrides: Partial<LLMHealthRead> = {},
): LLMHealthRead {
  return {
    provider: 'fastflowlm',
    model: 'qwen3.5:4b',
    available: false,
    detail: 'FastFlowLM setup is required.',
    unavailable_reason: 'fastflowlm_missing',
    configured_model: 'qwen3.5:4b',
    effective_model: null,
    fallback_models: ['qwen3.5:2b'],
    fallback_reason: null,
    ...overrides,
  };
}

function fastFlowRequirement(unavailableReason: string) {
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
    kind: 'fastflowlm',
    label: 'FastFlowLM',
    available: true,
    detail: 'FastFlowLM 0.9.43 is installed.',
    unavailable_reason: null,
    version: '0.9.43',
    bytes: 18_577_840,
    installed_path: 'C:\\Program Files\\flm\\flm.exe',
  };
}

function fastFlowModelRequirement(unavailableReason: string) {
  return {
    kind: 'fastflowlm_model',
    label: 'FastFlowLM model',
    available: false,
    detail: 'FastFlowLM model onboarding is required.',
    unavailable_reason: unavailableReason,
    version: 'qwen3.5:4b',
    bytes: null,
    installed_path: null,
  };
}

function fastFlowSelection() {
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
    terms_url: FASTFLOW_TERMS_URL,
    runtime_requirement_kind: 'fastflowlm',
    model_requirement_kind: 'fastflowlm_model',
  };
}

function activateDocument(
  sourceImport: SourceImportStore,
  document: ReturnType<typeof documentRead>,
): void {
  sourceImport.documents.set([document]);
  sourceImport.setActiveDocumentId(document.id);
}
