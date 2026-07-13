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

  it('requires FastFlowLM terms review before runtime or model installation', () => {
    const health = TestBed.inject(HealthStore);
    health.systemHealth.set(systemHealth());
    health.llmHealth.set({
      ...missingModelHealth(),
      provider: 'fastflowlm',
      model: 'qwen3.5:4b',
      detail: 'FastFlowLM terms must be accepted.',
      unavailable_reason: 'fastflowlm_not_running',
    });
    health.ocrHealth.set(ocrHealth());
    health.runtimeRequirements.set([
      fastFlowRuntimeAvailableRequirement(),
      fastFlowModelRequirement('fastflowlm_terms_required'),
    ]);

    const fixture = TestBed.createComponent(RuntimeManagerPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'Review FastFlowLM terms',
    );
    expect(fixture.nativeElement.textContent).not.toContain(
      'Install FastFlowLM',
    );
    expect(fixture.nativeElement.textContent).not.toContain(
      'Download qwen3.5:4b',
    );
  });

  it('offers FastFlowLM installation after terms are accepted', () => {
    const health = TestBed.inject(HealthStore);
    health.systemHealth.set(systemHealth());
    health.llmHealth.set({
      ...missingModelHealth(),
      provider: 'fastflowlm',
      model: 'qwen3.5:4b',
      detail: 'FastFlowLM is not installed.',
      unavailable_reason: 'fastflowlm_missing',
    });
    health.ocrHealth.set(ocrHealth());
    health.runtimeRequirements.set([
      fastFlowRuntimeMissingRequirement('fastflowlm_missing'),
    ]);

    const fixture = TestBed.createComponent(RuntimeManagerPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Install FastFlowLM');
    expect(fixture.nativeElement.textContent).not.toContain(
      'Review FastFlowLM terms',
    );
    expect(fixture.nativeElement.textContent).not.toContain(
      'Download qwen3.5:4b',
    );
  });

  it('offers the FastFlowLM model only after its runtime is ready', () => {
    const health = TestBed.inject(HealthStore);
    health.systemHealth.set(systemHealth());
    health.llmHealth.set({
      ...missingModelHealth(),
      provider: 'fastflowlm',
      model: 'qwen3.5:4b',
      configured_model: 'qwen3.5:4b',
      detail: 'FastFlowLM server is not running.',
      unavailable_reason: 'fastflowlm_not_running',
    });
    health.ocrHealth.set(ocrHealth());
    health.runtimeRequirements.set([
      fastFlowRuntimeAvailableRequirement(),
      fastFlowModelRequirement('model_missing'),
    ]);

    const fixture = TestBed.createComponent(RuntimeManagerPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Download qwen3.5:4b');
    expect(fixture.nativeElement.textContent).not.toContain(
      'Install FastFlowLM',
    );
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
    detail: 'FastFlowLM model setup is required.',
    unavailable_reason: unavailableReason,
    version: 'qwen3.5:4b',
    bytes: null,
    installed_path: null,
  };
}
