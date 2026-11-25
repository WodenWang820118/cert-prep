import { TestBed } from '@angular/core/testing';
import type { SourceRead } from '../../../core/domain';
import { appSource } from '../../../core/testing';
import type {
  SourceStatusViewModel,
  SourceImportAction,
} from '../../domain';
import { SourceStatusComponent } from './source-status.component';

describe('SourceStatusComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [SourceStatusComponent] });
  });

  it('guides the initial state without exposing operation internals', () => {
    const fixture = createFixture();
    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('Choose a source file');
    expect(text).not.toContain('processing');
    expect(text).not.toContain('operation');
    expect(text).not.toContain('elapsed');
  });

  it('shows a usable source and emits project-library selection', () => {
    const secondSource = { ...appSource, id: 'source-2', filename: 'network.pdf' };
    const fixture = createFixture({
      sources: [appSource, secondSource],
      activeSourceId: appSource.id,
      source: appSource,
    });
    const actions: SourceImportAction[] = [];
    fixture.componentInstance.action.subscribe((action) => actions.push(action));
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    select.value = secondSource.id;
    select.dispatchEvent(new Event('change'));

    expect(fixture.nativeElement.textContent).toContain('Ready to review');
    expect(fixture.nativeElement.textContent).toContain('Source evidence is ready');
    expect(actions).toEqual([{ type: 'select-source', sourceId: 'source-2' }]);
  });

  it('emits cancel and retry actions for processing and failed sources', () => {
    const processingFixture = createFixture({
      source: sourceRead({ status: 'processing', chunks_count: 1 }),
    });
    const processingActions: SourceImportAction[] = [];
    processingFixture.componentInstance.action.subscribe((action) => processingActions.push(action));
    buttonByText(processingFixture.nativeElement, 'Cancel').click();

    const failedFixture = createFixture({
      source: sourceRead({
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

  it('explains a failure only while the source has a failure status', () => {
    const failed = createFixture({
      source: sourceRead({
        status: 'no_text_detected',
        has_text: false,
        failure_message: 'No reviewable text.',
      }),
    });
    const readyAgain = createFixture({
      source: sourceRead({ status: 'ready', failure_message: 'No reviewable text.' }),
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
      source: sourceRead({
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
  overrides: Partial<SourceStatusViewModel> = {},
): ReturnType<typeof TestBed.createComponent<SourceStatusComponent>> {
  const fixture = TestBed.createComponent(SourceStatusComponent);
  fixture.componentRef.setInput('model', {
    sources: [],
    activeSourceId: null,
    source: null,
    streamError: null,
    cancelBusy: false,
    retryBusy: false,
    ...overrides,
  });
  fixture.detectChanges();
  return fixture;
}

function sourceRead(overrides: Partial<SourceRead> = {}): SourceRead {
  return {
    ...appSource,
    ...overrides,
  };
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  return Array.from(root.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === text,
  ) as HTMLButtonElement;
}
