import { TestBed } from '@angular/core/testing';
import type { SourceUploadItem } from '../../stores/source-import/contracts/source-import.contracts';
import type {
  SourceImportAction,
  SourceUploadQueueViewModel,
} from './source-import-panel.contracts';
import { SourceUploadQueueComponent } from './source-upload-queue.component';

describe('SourceUploadQueueComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [SourceUploadQueueComponent] });
  });

  it('renders the initial source choice without internal upload telemetry', () => {
    const fixture = createFixture({ selectedFileLabel: 'No source file selected' });
    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('Choose files');
    expect(text).toContain('Waiting for a source');
    expect(text).not.toContain('Concurrent uploads');
    expect(text).not.toContain('Elapsed time');
    expect(text).not.toContain('chunks');
  });

  it('keeps source language selection visible while advanced settings stay collapsed', () => {
    const fixture = createFixture({ languageHint: 'ja' });
    const root = fixture.nativeElement as HTMLElement;
    const language = root.querySelector('select[aria-label="Source language"]') as HTMLSelectElement;

    expect(root.querySelector('details')?.hasAttribute('open')).toBe(false);
    expect(root.textContent).toContain('Source language');
    expect(fixture.componentInstance.model().languageHint).toBe('ja');
    expect(Array.from(language.options).map((option) => option.value)).toEqual(['auto', 'ja']);
    expect(Array.from(language.options).map((option) => option.textContent?.trim())).toContain('Japanese');
  });

  it('emits selected files, upload, and optional-setting actions without a store dependency', () => {
    const fixture = createFixture({ canUpload: true });
    const actions: SourceImportAction[] = [];
    fixture.componentInstance.action.subscribe((action) => actions.push(action));
    const component = fixture.componentInstance as unknown as {
      chooseFiles(event: Event): void;
      setCropImagesBeforeUpload(enabled: boolean): void;
      setLanguage(value: string): void;
    };
    const file = new File(['pdf'], 'guide.pdf', { type: 'application/pdf' });
    const input = fixture.nativeElement.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });

    component.chooseFiles({ target: input } as unknown as Event);
    component.setCropImagesBeforeUpload(true);
    component.setLanguage('ja');
    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();

    expect(actions).toEqual([
      { type: 'choose-files', files: [file] },
      { type: 'set-crop-images', enabled: true },
      { type: 'set-language', value: 'ja' },
      { type: 'upload' },
    ]);
  });

  it('shows partial failure and exposes cancel/retry actions per item', () => {
    const fixture = createFixture({
      items: [
        uploadItem('upload-failed', 'failed', 'The PDF could not be uploaded.'),
        uploadItem('upload-queued', 'queued', null),
      ],
    });
    const actions: SourceImportAction[] = [];
    fixture.componentInstance.action.subscribe((action) => actions.push(action));

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('The PDF could not be uploaded.');
    expect(root.textContent).toContain('Upload failed');
    (root.querySelector('[aria-label="Retry upload of upload-failed.pdf"]') as HTMLButtonElement).click();
    const cancelButton = Array.from(root.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Cancel',
    ) as HTMLButtonElement;
    cancelButton.click();

    expect(actions).toEqual([
      { type: 'retry-upload', itemId: 'upload-failed' },
      { type: 'cancel-upload', itemId: 'upload-queued' },
    ]);
  });
});

function createFixture(
  overrides: Partial<SourceUploadQueueViewModel> = {},
): ReturnType<typeof TestBed.createComponent<SourceUploadQueueComponent>> {
  const fixture = TestBed.createComponent(SourceUploadQueueComponent);
  fixture.componentRef.setInput('model', {
    accept: '.pdf,.png,.jpg,.jpeg,.webp,.mp3,.wav,.m4a',
    items: [],
    selectedFileLabel: 'No source file selected',
    canUpload: false,
    uploadBusy: false,
    fileSelectionBlocked: false,
    cropImagesBeforeUpload: false,
    languageHint: 'auto',
    languageHints: ['auto', 'ja'],
    operationError: null,
    ...overrides,
  });
  fixture.detectChanges();
  return fixture;
}

function uploadItem(
  id: string,
  status: SourceUploadItem['status'],
  error: string | null,
): SourceUploadItem {
  return {
    id,
    file: new File(['source'], `${id}.pdf`, { type: 'application/pdf' }),
    status,
    document: null,
    error,
  };
}
