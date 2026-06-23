import { TestBed } from '@angular/core/testing';
import { EXAM_PREP_API, LLMHealthRead } from '../../exam-prep-api';
import { HealthStore } from '../../stores/health/health.store';
import { ModelHealthComponent } from './model-health.component';
import {
  availableLlmHealth,
  buttonByText,
  fallbackLlmHealth,
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
      providers: [{ provide: EXAM_PREP_API, useValue: apiClient }],
    }).compileComponents();
  });

  it('renders compact status chips and keeps details in the manager', () => {
    const fixture = TestBed.createComponent(ModelHealthComponent);
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
    expect(buttonByText(fixture.nativeElement, 'Manage runtime')).not.toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Runtime details');

    buttonByText(fixture.nativeElement, 'Manage runtime')?.click();
    fixture.detectChanges();

    expect(document.body.textContent).toContain('Runtime details');
    expect(document.body.textContent).toContain('Python backend');
    expect(document.body.textContent).toContain('Reasoning model');
    expect(document.body.textContent).toContain('PaddleOCR');
  });

  it('shows effective fallback model and still offers primary model download', () => {
    const fixture = TestBed.createComponent(ModelHealthComponent);
    const health = TestBed.inject(HealthStore);
    health.systemHealth.set(systemHealth());
    health.llmHealth.set(fallbackLlmHealth());
    health.ocrHealth.set(ocrHealth());

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'Reasoning model: qwen3.5:2b',
    );
    expect(fixture.nativeElement.textContent).not.toContain(
      'Reasoning model missing',
    );

    buttonByText(fixture.nativeElement, 'Manage runtime')?.click();
    fixture.detectChanges();

    expect(document.body.textContent).toContain('Ready via fallback');
    expect(document.body.textContent).toContain('primary qwen3.5:4b');
    expect(buttonByText(document.body, 'Download qwen3.5:4b')).not.toBeNull();
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
    health.systemHealth.set(systemHealth());
    health.llmHealth.set(availableLlmHealth());
    health.ocrHealth.set(null);
    health.healthSnapshotLoading.set(true);

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('OCR checking');
    expect(fixture.nativeElement.textContent).not.toContain('OCR unknown');

    buttonByText(fixture.nativeElement, 'Manage runtime')?.click();
    fixture.detectChanges();

    expect(document.body.textContent).toContain('Checking');
    expect(document.body.textContent).toContain(
      'Checking PaddleOCR runtime health.',
    );
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

    buttonByText(fixture.nativeElement, 'Manage runtime')?.click();
    fixture.detectChanges();

    expect(document.body.textContent).toContain('Stale');
    expect(document.body.textContent).toContain(
      'Refreshing cached PaddleOCR status.',
    );
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
    buttonByText(fixture.nativeElement, 'Manage runtime')?.click();
    fixture.detectChanges();

    expect(document.body.textContent).toContain('WindowsML OCR');
    buttonByText(document.body, 'Install OCR')?.click();
    fixture.detectChanges();

    expect(document.body.textContent).toContain(
      'Install the WindowsML OCR runtime for image-only PDFs?',
    );
    expect(document.body.textContent).toContain(
      'the Nvidia GPU remains available for reasoning',
    );
  });
});
