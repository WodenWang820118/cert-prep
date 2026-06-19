import { TestBed } from '@angular/core/testing';
import { EXAM_PREP_API, LLMHealthRead, OCRHealthRead } from '../../exam-prep-api';
import { HealthStore } from '../../stores/health/health.store';
import { ModelHealthComponent } from './model-health.component';

describe('ModelHealthComponent', () => {
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
      health: vi.fn().mockResolvedValue({
        status: 'ok',
        app: 'exam-prep-backend',
        version: '0.1.0',
        python_version: '3.13.5',
        runtime_mode: 'source',
      }),
      llmHealth: vi.fn(),
      ocrHealth: vi.fn(),
      runtimeRequirements: vi.fn().mockResolvedValue({ items: [] }),
      startModelDownload: vi.fn(),
      startRuntimeInstallation: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [ModelHealthComponent],
      providers: [{ provide: EXAM_PREP_API, useValue: apiClient }],
    }).compileComponents();
  });

  it('renders compact status chips and keeps details in the manager', () => {
    const fixture = TestBed.createComponent(ModelHealthComponent);
    const health = TestBed.inject(HealthStore);
    health.systemHealth.set({
      status: 'ok',
      app: 'exam-prep-backend',
      version: '0.1.0',
      python_version: '3.13.5',
      runtime_mode: 'source',
    });
    health.llmHealth.set({
      provider: 'fake',
      model: 'reasoner:7b',
      available: true,
      detail: 'deterministic local fake provider',
      unavailable_reason: null,
    });
    health.ocrHealth.set(ocrHealth());

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Python 3.13.5');
    expect(fixture.nativeElement.textContent).toContain(
      'Reasoning model: reasoner:7b',
    );
    expect(fixture.nativeElement.textContent).not.toContain('gemma4:12b');
    expect(fixture.nativeElement.textContent).toContain('paddle / cpu');
    expect(buttonByText(fixture.nativeElement, 'Manage runtime')).not.toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Runtime details');

    buttonByText(fixture.nativeElement, 'Manage runtime')?.click();
    fixture.detectChanges();

    expect(document.body.textContent).toContain('Runtime details');
    expect(document.body.textContent).toContain('Python backend');
    expect(document.body.textContent).toContain('Reasoning model');
    expect(document.body.textContent).toContain('PaddleOCR');
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
    buttonByText(fixture.nativeElement, 'Manage runtime')?.click();
    fixture.detectChanges();

    expect(buttonByText(document.body, 'Download model')).toBeNull();
  });

  it('shows OCR checking copy while health is still settling', () => {
    const fixture = TestBed.createComponent(ModelHealthComponent);
    const health = TestBed.inject(HealthStore);
    health.systemHealth.set({
      status: 'ok',
      app: 'exam-prep-backend',
      version: '0.1.0',
      python_version: '3.13.5',
      runtime_mode: 'source',
    });
    health.llmHealth.set({
      provider: 'fake',
      model: 'reasoner:7b',
      available: true,
      detail: 'deterministic local fake provider',
      unavailable_reason: null,
    });
    health.ocrHealth.set(null);
    health.healthSnapshotLoading.set(true);

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('OCR checking');
    expect(fixture.nativeElement.textContent).not.toContain('OCR unknown');

    buttonByText(fixture.nativeElement, 'Manage runtime')?.click();
    fixture.detectChanges();

    expect(document.body.textContent).toContain('Checking');
    expect(document.body.textContent).toContain('PaddleOCR is warming up.');
  });

  it('opens consent and cancel does not start the download', async () => {
    const fixture = TestBed.createComponent(ModelHealthComponent);
    const health = TestBed.inject(HealthStore);
    health.llmHealth.set(missingModelHealth());
    health.ocrHealth.set(ocrHealth());
    fixture.detectChanges();

    buttonByText(fixture.nativeElement, 'Manage runtime')?.click();
    fixture.detectChanges();
    buttonByText(document.body, 'Download model')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(health.modelDownloadConsentVisible()).toBe(true);
    expect(document.body.textContent).toContain(
      'Download reasoner:7b with Ollama?',
    );

    buttonByText(document.body, 'Cancel')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(health.modelDownloadConsentVisible()).toBe(false);
    expect(apiClient.startModelDownload).not.toHaveBeenCalled();
  });

  it('opens Ollama install consent for missing Ollama', async () => {
    const fixture = TestBed.createComponent(ModelHealthComponent);
    const health = TestBed.inject(HealthStore);
    health.llmHealth.set({
      ...missingModelHealth(),
      detail: 'Ollama is not installed.',
      unavailable_reason: 'ollama_missing',
    });
    health.ocrHealth.set(ocrHealth());
    fixture.detectChanges();

    buttonByText(fixture.nativeElement, 'Manage runtime')?.click();
    fixture.detectChanges();
    buttonByText(document.body, 'Install Ollama')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(health.runtimeInstallConsentVisible()).toBe(true);
    expect(document.body.textContent).toContain(
      'Install Ollama for local AI generation?',
    );

    buttonByText(document.body, 'Cancel')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(health.runtimeInstallConsentVisible()).toBe(false);
    expect(apiClient.startRuntimeInstallation).not.toHaveBeenCalled();
  });
});

function buttonByText(
  root: ParentNode,
  text: string,
): HTMLButtonElement | null {
  return (
    Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(text),
    ) ?? null
  );
}

function missingModelHealth(): LLMHealthRead & { unavailable_reason: string } {
  return {
    provider: 'ollama',
    model: 'reasoner:7b',
    available: false,
    detail: 'Ollama model reasoner:7b is missing.',
    unavailable_reason: 'model_missing',
  };
}

function ocrHealth(): OCRHealthRead {
  return {
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
  };
}
