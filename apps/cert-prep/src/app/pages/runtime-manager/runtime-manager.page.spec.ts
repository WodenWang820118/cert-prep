import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import { HealthStore } from '../../stores/health/health.store';
import {
  availableLlmHealth,
  buttonByText,
  fallbackLlmHealth,
  missingModelHealth,
  ocrHealth,
  systemHealth,
} from '../../components/model-health/model-health.component.spec-helpers';
import { RuntimeManagerPage } from './runtime-manager.page';

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
