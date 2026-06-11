import { TestBed } from '@angular/core/testing';
import { EXAM_PREP_API, LLMHealthRead, OCRHealthRead } from '../exam-prep-api';
import { HealthStore } from '../stores/health.store';
import { ModelHealthComponent } from './model-health.component';

describe('ModelHealthComponent', () => {
  let apiClient: {
    getModelDownload: ReturnType<typeof vi.fn>;
    llmHealth: ReturnType<typeof vi.fn>;
    ocrHealth: ReturnType<typeof vi.fn>;
    startModelDownload: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    apiClient = {
      getModelDownload: vi.fn(),
      llmHealth: vi.fn(),
      ocrHealth: vi.fn(),
      startModelDownload: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [ModelHealthComponent],
      providers: [{ provide: EXAM_PREP_API, useValue: apiClient }],
    }).compileComponents();
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

    expect(buttonByText(fixture.nativeElement, 'Download model')).toBeNull();
  });

  it('opens consent and cancel does not start the download', async () => {
    const fixture = TestBed.createComponent(ModelHealthComponent);
    const health = TestBed.inject(HealthStore);
    health.llmHealth.set(missingModelHealth());
    health.ocrHealth.set(ocrHealth());
    fixture.detectChanges();

    buttonByText(fixture.nativeElement, 'Download model')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(health.modelDownloadConsentVisible()).toBe(true);
    expect(document.body.textContent).toContain(
      'Download gemma4:12b with Ollama?',
    );

    buttonByText(document.body, 'Cancel')?.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(health.modelDownloadConsentVisible()).toBe(false);
    expect(apiClient.startModelDownload).not.toHaveBeenCalled();
  });
});

function buttonByText(root: ParentNode, text: string): HTMLButtonElement | null {
  return (
    Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(text),
    ) ?? null
  );
}

function missingModelHealth(): LLMHealthRead & { unavailable_reason: string } {
  return {
    provider: 'ollama',
    model: 'gemma4:12b',
    available: false,
    detail: 'Ollama model gemma4:12b is missing.',
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
  };
}
