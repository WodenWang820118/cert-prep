import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import { HealthStore } from '../../stores/health/health.store';
import {
  availableLlmHealth,
  buttonByText,
  cpuExecutionLlmHealth,
  fallbackLlmHealth,
  missingModelHealth,
  ocrHealth,
  systemHealth,
} from '../../components/model-health/model-health.component.spec-helpers';
import { ModelHealthViewModelFacade } from '../../components/model-health/model-health-view-model.facade';
import { RuntimeManagerPage } from './runtime-manager.page';
import { providerSelection } from '../../stores/health/health.store.spec-helpers';

describe('RuntimeManagerPage', () => {
  let apiClient: {
    getModelDownload: ReturnType<typeof vi.fn>;
    getRuntimeInstallation: ReturnType<typeof vi.fn>;
    health: ReturnType<typeof vi.fn>;
    llmHealth: ReturnType<typeof vi.fn>;
    ocrHealth: ReturnType<typeof vi.fn>;
    runtimeRequirements: ReturnType<typeof vi.fn>;
    startModelDownload: ReturnType<typeof vi.fn>;
    startRuntimeInstallation: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    apiClient = {
      getModelDownload: vi.fn(),
      getRuntimeInstallation: vi.fn(),
      health: vi.fn().mockResolvedValue(systemHealth()),
      llmHealth: vi.fn().mockResolvedValue(availableLlmHealth()),
      ocrHealth: vi.fn().mockResolvedValue(ocrHealth()),
      runtimeRequirements: vi.fn().mockResolvedValue({ items: [] }),
      startModelDownload: vi.fn(),
      startRuntimeInstallation: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [RuntimeManagerPage],
      providers: [{ provide: CERT_PREP_API, useValue: apiClient }],
    }).compileComponents();
  });

  it('renders runtime rows and a model download action', () => {
    const health = TestBed.inject(HealthStore);
    health.systemHealth.set(systemHealth());
    health.llmHealth.set(missingModelHealth());
    health.ocrHealth.set(ocrHealth());

    const fixture = TestBed.createComponent(RuntimeManagerPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Manage runtime');
    expect(fixture.nativeElement.textContent).toContain('Python backend');
    expect(fixture.nativeElement.textContent).toContain('Reasoning model');
    expect(fixture.nativeElement.textContent).toContain('PaddleOCR');
    expect(fixture.nativeElement.textContent).toContain('Download reasoner:7b');
  });

  it('renders fallback model detail and primary model download action', () => {
    const health = TestBed.inject(HealthStore);
    health.systemHealth.set(systemHealth());
    health.llmHealth.set(fallbackLlmHealth());
    health.ocrHealth.set(ocrHealth());

    const fixture = TestBed.createComponent(RuntimeManagerPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'Ready via fallback qwen3.5:2b; primary qwen3.5:4b is not installed.',
    );
    expect(fixture.nativeElement.textContent).toContain('Download qwen3.5:4b');
  });

  it('renders backend-owned auto selection and explicit fallback attribution', () => {
    const health = TestBed.inject(HealthStore);
    health.systemHealth.set(systemHealth());
    health.llmHealth.set({
      ...availableLlmHealth(),
      provider: 'ollama',
      model: 'qwen3.5:4b',
      configured_model: 'qwen3.5:4b',
      effective_model: 'qwen3.5:4b',
    });
    health.providerSelection.set(
      providerSelection({
        selected_provider: 'ollama',
        effective_provider: 'ollama',
        selection_reason:
          'Auto-selected Ollama: The AMD accelerator driver must be at least 32.0.203.304.',
        fallback_reason:
          'The AMD accelerator driver must be at least 32.0.203.304.',
        runtime_requirement_kind: 'ollama',
        model_requirement_kind: 'ollama_model',
      }),
    );
    health.ocrHealth.set(ocrHealth());

    const fixture = TestBed.createComponent(RuntimeManagerPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('LLM provider policy');
    expect(fixture.nativeElement.textContent).toContain('Auto selection');
    expect(fixture.nativeElement.textContent).toContain('Ollama / qwen3.5:4b');
    expect(fixture.nativeElement.textContent).toContain('Fallback active');
    expect(fixture.nativeElement.textContent).toContain(
      'The AMD accelerator driver must be at least 32.0.203.304.',
    );
  });

  it('renders CPU execution as a warning without hiding model fallback detail', () => {
    const health = TestBed.inject(HealthStore);
    health.systemHealth.set(systemHealth());
    health.llmHealth.set(
      cpuExecutionLlmHealth({
        effective_model: 'qwen3.5:2b',
        fallback_models: ['qwen3.5:2b'],
        fallback_reason:
          'Configured model qwen3.5:4b is missing; using fallback qwen3.5:2b.',
      }),
    );
    health.ocrHealth.set(ocrHealth());

    const fixture = TestBed.createComponent(RuntimeManagerPage);
    fixture.detectChanges();

    const modelView = TestBed.inject(ModelHealthViewModelFacade).viewModel().model;
    expect(modelView).toMatchObject({
      statusLabel: '使用 CPU 中',
      severity: 'warn',
    });
    expect(modelView.detail).toContain(
      'GPU acceleration conditions were not met; Ollama is using CPU.',
    );
    expect(modelView.detail).toContain(
      'Ready via fallback qwen3.5:2b; primary qwen3.5:4b is not installed.',
    );
    expect(fixture.nativeElement.textContent).toContain('使用 CPU 中');
    expect(fixture.nativeElement.textContent).toContain(
      'GPU acceleration conditions were not met; Ollama is using CPU.',
    );
  });

  it('offers Ollama onboarding when the selected provider runtime is missing', () => {
    const health = TestBed.inject(HealthStore);
    health.systemHealth.set(systemHealth());
    health.llmHealth.set({
      ...missingModelHealth(),
      provider: 'ollama',
      detail: 'Ollama is not installed.',
      unavailable_reason: 'ollama_missing',
    });
    health.providerSelection.set(providerSelection());
    health.runtimeRequirements.set([
      {
        kind: 'ollama',
        label: 'Ollama',
        available: false,
        detail: 'Ollama is not installed.',
        unavailable_reason: 'ollama_missing',
      },
    ]);
    health.ocrHealth.set(ocrHealth());

    const fixture = TestBed.createComponent(RuntimeManagerPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Ollama');
    expect(
      buttonByText(fixture.nativeElement, 'Install Ollama'),
    ).not.toBeNull();
  });

  it('renders OCR checking detail while health is loading', () => {
    const health = TestBed.inject(HealthStore);
    health.systemHealth.set(systemHealth());
    health.llmHealth.set(availableLlmHealth());
    health.ocrHealth.set(null);
    health.healthSnapshotLoading.set(true);

    const fixture = TestBed.createComponent(RuntimeManagerPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Checking');
    expect(fixture.nativeElement.textContent).toContain(
      'Checking PaddleOCR runtime health.',
    );
  });

  it('renders stale OCR detail while refreshing cached OCR health', async () => {
    const health = TestBed.inject(HealthStore);
    health.systemHealth.set(systemHealth());
    health.llmHealth.set(availableLlmHealth());
    health.ocrHealth.set(ocrHealth());
    apiClient.llmHealth.mockResolvedValueOnce(availableLlmHealth());
    apiClient.ocrHealth.mockRejectedValueOnce(new Error('ocr unavailable'));

    await health.load();

    const fixture = TestBed.createComponent(RuntimeManagerPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Stale');
    expect(fixture.nativeElement.textContent).toContain(
      'Refreshing cached PaddleOCR status.',
    );
  });

  it('renders WindowsML OCR install copy and action when runtime is missing', () => {
    const health = TestBed.inject(HealthStore);
    health.systemHealth.set(systemHealth());
    health.llmHealth.set(availableLlmHealth());
    health.ocrHealth.set({
      ...ocrHealth(),
      provider: 'windowsml',
      engine: 'onnxruntime-windowsml',
      available: false,
      detail: 'WindowsML OCR runtime is not installed.',
      selected_device: null,
      unavailable_reason: 'windowsml_runtime_missing',
    });

    const fixture = TestBed.createComponent(RuntimeManagerPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('WindowsML OCR');
    expect(fixture.nativeElement.textContent).toContain(
      'WindowsML OCR runtime is not installed.',
    );
    expect(fixture.nativeElement.textContent).toContain('Install OCR');
  });

  it('does not render close controls on the route surface', () => {
    const fixture = TestBed.createComponent(RuntimeManagerPage);
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(
      compiled.querySelector('[aria-label="Close runtime manager"]'),
    ).toBeNull();
    expect(buttonByText(compiled, 'Cancel')).toBeNull();
    expect(buttonByText(compiled, 'Refresh all')).not.toBeNull();
  });

  it('renders cancellation controls only for cancellable active jobs', () => {
    const health = TestBed.inject(HealthStore);
    health.systemHealth.set(systemHealth());
    health.llmHealth.set(availableLlmHealth());
    health.ocrHealth.set(ocrHealth());
    health.modelDownload.set({
      jobId: 'model-job-1',
      model: 'qwen3.5:4b',
      phase: 'running',
      status: 'running',
      progress: 25,
      message: 'Downloading model',
      error: null,
      cancellable: true,
    });
    health.runtimeInstall.set({
      jobId: 'runtime-job-1',
      kind: 'ollama',
      label: 'Ollama',
      phase: 'running',
      status: 'running',
      progress: 25,
      message: 'Installing Ollama',
      error: null,
      cancellable: true,
    });

    const fixture = TestBed.createComponent(RuntimeManagerPage);
    fixture.detectChanges();

    expect(buttonByText(fixture.nativeElement, 'Cancel model')).not.toBeNull();
    expect(
      buttonByText(fixture.nativeElement, 'Cancel install'),
    ).not.toBeNull();
  });

  it('emits close requests from the modal surface', () => {
    const fixture = TestBed.createComponent(RuntimeManagerPage);
    const closeRequested = vi.fn();
    fixture.componentRef.setInput('modal', true);
    fixture.componentInstance.closeRequested.subscribe(closeRequested);
    fixture.detectChanges();

    buttonByText(fixture.nativeElement, 'Cancel')?.click();

    expect(closeRequested).toHaveBeenCalledOnce();
  });
});
