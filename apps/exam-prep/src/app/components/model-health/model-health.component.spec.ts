import { TestBed } from '@angular/core/testing';
import { EXAM_PREP_API, LLMHealthRead } from '../../exam-prep-api';
import { HealthStore } from '../../stores/health/health.store';
import { ModelHealthComponent } from './model-health.component';
import {
  availableLlmHealth,
  buttonByText,
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
    expect(document.body.textContent).toContain('PaddleOCR is warming up.');
  });
});
