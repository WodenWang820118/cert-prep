import { TestBed } from '@angular/core/testing';
import type { DocumentRead } from '../../../core/domain';
import { appDocument } from '../../../core/testing';
import type {
  SourceDocumentStatusViewModel,
  SourceImportAction,
} from '../../domain';
import { SourceDocumentStatusComponent } from './source-document-status.component';

describe('SourceDocumentStatusComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [SourceDocumentStatusComponent] });
  });

  it('guides the initial state without exposing operation internals', () => {
    const fixture = createFixture();
    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('Choose a source file');
    expect(text).not.toContain('processing');
    expect(text).not.toContain('operation');
    expect(text).not.toContain('elapsed');
  });

  it('shows a usable document and emits project-library selection', () => {
    const secondDocument = { ...appDocument, id: 'document-2', filename: 'network.pdf' };
    const fixture = createFixture({
      documents: [appDocument, secondDocument],
      activeDocumentId: appDocument.id,
      document: appDocument,
    });
    const actions: SourceImportAction[] = [];
    fixture.componentInstance.action.subscribe((action) => actions.push(action));
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    select.value = secondDocument.id;
    select.dispatchEvent(new Event('change'));

    expect(fixture.nativeElement.textContent).toContain('Ready to review');
    expect(fixture.nativeElement.textContent).toContain('Source evidence is ready');
    expect(actions).toEqual([{ type: 'select-document', documentId: 'document-2' }]);
  });

  it('emits cancel and retry actions for processing and failed documents', () => {
    const processingFixture = createFixture({
      document: documentRead({ status: 'processing', chunks_count: 1 }),
    });
    const processingActions: SourceImportAction[] = [];
    processingFixture.componentInstance.action.subscribe((action) => processingActions.push(action));
    buttonByText(processingFixture.nativeElement, 'Cancel').click();

    const failedFixture = createFixture({
      document: documentRead({
        status: 'extraction_failed',
        has_text: false,
        failure_message: 'Text recognition is unavailable.',
      }),
    });
    const failedActions: SourceImportAction[] = [];
    failedFixture.componentInstance.action.subscribe((action) => failedActions.push(action));
    buttonByText(failedFixture.nativeElement, 'Retry source processing').click();

    expect(processingActions).toEqual([{ type: 'cancel-processing' }]);
    expect(failedActions).toEqual([{ type: 'retry-processing' }]);
    expect(failedFixture.nativeElement.querySelector('h3')?.textContent?.trim()).toBe('Source could not be read');
    expect(failedFixture.nativeElement.textContent).toContain('Retry source processing');
    expect(failedFixture.nativeElement.textContent).toContain('Text recognition is unavailable.');
    expect(failedFixture.nativeElement.textContent).not.toContain('Check the extracted text');
  });

  it('explains a failure only while the document has a failure status', () => {
    const failed = createFixture({
      document: documentRead({
        status: 'no_text_detected',
        has_text: false,
        failure_message: 'No reviewable text.',
      }),
    });
    const readyAgain = createFixture({
      document: documentRead({ status: 'ready', failure_message: 'No reviewable text.' }),
    });

    expect(failed.nativeElement.querySelector('[role="alert"]')?.textContent).toContain(
      'Why it failed: No reviewable text.',
    );
    expect(readyAgain.nativeElement.textContent).toContain('Ready to review');
    expect(readyAgain.nativeElement.textContent).not.toContain('No reviewable text.');
    expect(readyAgain.nativeElement.textContent).not.toContain('Why it failed');
  });

  it('keeps internal stream and fallback details out of the human-facing status', () => {
    const fixture = createFixture({
      document: documentRead({
        status: 'ready',
        extraction_warnings: 'Internal extraction warning',
      }),
      streamError: 'SSE connection error: status=503',
    });

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Check the extracted text before practice.');
    expect(text).toContain('We could not update the source status.');
    expect(text).toContain('Retry source status');
    expect(text).not.toContain('Internal extraction warning');
    expect(text).not.toContain('SSE connection error');
  });
});

function createFixture(
  overrides: Partial<SourceDocumentStatusViewModel> = {},
): ReturnType<typeof TestBed.createComponent<SourceDocumentStatusComponent>> {
  const fixture = TestBed.createComponent(SourceDocumentStatusComponent);
  fixture.componentRef.setInput('model', {
    documents: [],
    activeDocumentId: null,
    document: null,
    streamError: null,
    cancelBusy: false,
    retryBusy: false,
    ...overrides,
  });
  fixture.detectChanges();
  return fixture;
}

function documentRead(overrides: Partial<DocumentRead> = {}): DocumentRead {
  return {
    ...appDocument,
    ...overrides,
  };
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  return Array.from(root.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === text,
  ) as HTMLButtonElement;
}
