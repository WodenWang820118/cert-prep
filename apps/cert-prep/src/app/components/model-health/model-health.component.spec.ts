import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { CERT_PREP_API, LLMHealthRead } from '../../cert-prep-api';
import { HealthStore } from '../../stores/health/health.store';
import { RuntimeManagerPage } from '../../pages/runtime-manager/runtime-manager.page';
import { ModelHealthComponent } from './model-health.component';
import { ModelHealthViewModelFacade } from './model-health-view-model.facade';
import {
  availableLlmHealth,
  buttonByText,
  cpuExecutionLlmHealth,
  cpuFallbackOcrHealth,
  missingModelHealth,
  ocrHealth,
  systemHealth,
} from './model-health.component.spec-helpers';

describe('ModelHealthComponent status display', () => {
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
      llmHealth: vi.fn(),
      ocrHealth: vi.fn(),
      runtimeRequirements: vi.fn().mockResolvedValue({ items: [] }),
      startModelDownload: vi.fn(),
      startRuntimeInstallation: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [ModelHealthComponent],
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        provideRouter([{ path: 'runtime', component: RuntimeManagerPage }]),
      ],
    }).compileComponents();
  });

  it('renders compact status chips and navigates to the runtime page', async () => {
    const fixture = TestBed.createComponent(ModelHealthComponent);
    const router = TestBed.inject(Router);
    const health = TestBed.inject(HealthStore);
    health.systemHealth.set(systemHealth());
    health.llmHealth.set(availableLlmHealth());
    health.ocrHealth.set(ocrHealth());

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Python 3.13.5');
    expect(fixture.nativeElement.textContent).toContain(
      'Reasoning model: reasoner:7b',
    );
    expect(fixture.nativeElement.textContent).not.toContain('gemma4:12b');
    expect(fixture.nativeElement.textContent).toContain('paddle / cpu');
    expect(
      buttonByText(fixture.nativeElement, 'Manage runtime'),
    ).not.toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Runtime details');

    buttonByText(fixture.nativeElement, 'Manage runtime')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(router.url).toBe('/runtime');
  });

  it('shows CPU execution for the fixed reasoning model', () => {
    const fixture = TestBed.createComponent(ModelHealthComponent);
    const health = TestBed.inject(HealthStore);
    health.systemHealth.set(systemHealth());
    health.llmHealth.set(cpuExecutionLlmHealth());
    health.ocrHealth.set(ocrHealth());

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'Reasoning model: qwen3.5:4b · 使用 CPU 中',
    );
    expect(fixture.nativeElement.textContent).not.toContain(
      'Reasoning model missing',
    );
  });

  it('shows WindowsML OCR CPU fallback as a warning state', () => {
    const fixture = TestBed.createComponent(ModelHealthComponent);
    const health = TestBed.inject(HealthStore);
    health.systemHealth.set(systemHealth());
    health.llmHealth.set(availableLlmHealth());
    health.ocrHealth.set(cpuFallbackOcrHealth());

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'WindowsML OCR · 使用 CPU 中',
    );
  });

  it('keeps an unavailable OCR error visible instead of a stale fallback warning', () => {
    const fixture = TestBed.createComponent(ModelHealthComponent);
    const health = TestBed.inject(HealthStore);
    const viewModels = TestBed.inject(ModelHealthViewModelFacade);
    health.systemHealth.set(systemHealth());
    health.llmHealth.set(availableLlmHealth());
    health.ocrHealth.set({
      ...cpuFallbackOcrHealth(),
      available: false,
      detail: 'WindowsML OCR model artifacts are missing.',
      unavailable_reason: 'windowsml_model_artifacts_missing',
    });

    fixture.detectChanges();

    expect(viewModels.viewModel().ocr.detail).toBe(
      'WindowsML OCR model artifacts are missing.',
    );
    expect(fixture.nativeElement.textContent).not.toContain(
      'WindowsML acceleration was not confirmed',
    );
  });

  it('does not report CPU execution while Ollama is offline', () => {
    const fixture = TestBed.createComponent(ModelHealthComponent);
    const health = TestBed.inject(HealthStore);
    health.systemHealth.set(systemHealth());
    health.llmHealth.set(
      cpuExecutionLlmHealth({
        available: false,
        detail: 'Ollama unavailable: connection refused',
        unavailable_reason: 'ollama_not_running',
      }),
    );
    health.ocrHealth.set(ocrHealth());

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain('使用 CPU 中');
  });

  it('hides the download action for generic offline health', () => {
    const fixture = TestBed.createComponent(ModelHealthComponent);
    const health = TestBed.inject(HealthStore);
    health.llmHealth.set({
      ...missingModelHealth(),
      detail: 'Ollama unavailable: connection refused',
      unavailable_reason: 'ollama_offline',
    } as LLMHealthRead & { unavailable_reason: string });
    health.ocrHealth.set(ocrHealth());

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain('Download model');
  });

  it('shows the selected Ollama runtime as missing before model onboarding', () => {
    const fixture = TestBed.createComponent(ModelHealthComponent);
    const health = TestBed.inject(HealthStore);
    health.systemHealth.set(systemHealth());
    health.llmHealth.set({
      provider: 'ollama',
      model: 'qwen3.5:4b',
      available: false,
      detail: 'Ollama is not installed.',
      unavailable_reason: 'ollama_missing',
      effective_model: null,
      fallback_models: [],
      fallback_reason: null,
    } as LLMHealthRead & { unavailable_reason: string });
    health.ocrHealth.set(ocrHealth());

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Ollama missing');
    expect(fixture.nativeElement.textContent).not.toContain(
      'Reasoning model missing',
    );
  });

  it('shows OCR checking copy while health is still settling', () => {
    const fixture = TestBed.createComponent(ModelHealthComponent);
    const health = TestBed.inject(HealthStore);
    health.systemHealth.set(systemHealth());
    health.llmHealth.set(availableLlmHealth());
    health.ocrHealth.set(null);
    health.healthSnapshotLoading.set(true);

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('OCR checking');
    expect(fixture.nativeElement.textContent).not.toContain('OCR unknown');
  });

  it('shows stale OCR copy while refreshing a cached OCR status', async () => {
    const fixture = TestBed.createComponent(ModelHealthComponent);
    const health = TestBed.inject(HealthStore);
    health.systemHealth.set(systemHealth());
    health.llmHealth.set(availableLlmHealth());
    health.ocrHealth.set(ocrHealth());
    apiClient.llmHealth.mockResolvedValueOnce(availableLlmHealth());
    apiClient.ocrHealth.mockRejectedValueOnce(new Error('ocr unavailable'));

    await health.load();

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('OCR stale');
    expect(fixture.nativeElement.textContent).not.toContain('OCR unknown');
  });

  it('shows WindowsML OCR runtime install copy when WindowsML runtime is missing', () => {
    const fixture = TestBed.createComponent(ModelHealthComponent);
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

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('OCR missing');
    expect(fixture.nativeElement.textContent).not.toContain('OCR unknown');
  });
});
