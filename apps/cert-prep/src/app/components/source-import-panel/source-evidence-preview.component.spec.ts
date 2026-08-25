import { TestBed } from '@angular/core/testing';
import type { ChunkRead } from '../../contracts/api.contracts';
import { appDocument } from '../../testing/app.spec-helpers';
import type {
  SourceEvidenceViewModel,
  SourceImportAction,
} from './source-import-panel.contracts';
import { SourceEvidencePreviewComponent } from './source-evidence-preview.component';

describe('SourceEvidencePreviewComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [SourceEvidencePreviewComponent] });
  });

  it('renders an input-only empty state without a store dependency', () => {
    const fixture = createFixture();
    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('Select a source to inspect its evidence.');
    expect(text).not.toContain('Capture Runtime');
    expect(text).not.toContain('elapsed');
    expect(text).not.toContain('concurrency');
  });

  it('renders document evidence without internal extraction metrics', () => {
    const fixture = createFixture({
      document: appDocument,
      chunks: [chunkRead()],
    });
    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('Source evidence');
    expect(text).toContain('Page 2 · Evidence 1');
    expect(text).toContain('Readable source excerpt');
    expect(text).not.toContain('Extraction');
    expect(text).not.toContain('chunks');
    expect(text).not.toContain('device');
  });

  it('emits transcript actions from typed inputs and one action output', () => {
    const fixture = createFixture({
      document: { ...appDocument, source_kind: 'audio' },
      chunks: [
        chunkRead({
          locator_kind: 'time',
          start_ms: 1_000,
          end_ms: 2_000,
          translated_text: 'Translated excerpt',
          translation_stale: true,
        }),
      ],
      hiddenChunkCount: 2,
      audio: { url: 'blob:audio', loading: false, error: null },
    });
    const actions: SourceImportAction[] = [];
    fixture.componentInstance.action.subscribe((action) => actions.push(action));
    const root = fixture.nativeElement as HTMLElement;
    const textarea = root.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'Edited Japanese transcript';
    (buttonByText(root, 'Save transcript')).click();
    buttonByText(root, 'Translate').click();
    buttonByText(root, 'Translate unfinished segments').click();
    buttonByText(root, 'Show more').click();

    expect(actions).toEqual([
      {
        type: 'update-transcript',
        chunkId: 'chunk-1',
        text: 'Edited Japanese transcript',
      },
      { type: 'translate-transcript', chunkId: 'chunk-1' },
      { type: 'translate-stale-transcript' },
      { type: 'show-more-evidence' },
    ]);
  });

  it('offers an audio retry when the authenticated preview fails', () => {
    const fixture = createFixture({
      document: { ...appDocument, source_kind: 'audio' },
      chunks: [chunkRead({ locator_kind: 'time', start_ms: 0, end_ms: 1_000 })],
      audio: {
        url: null,
        loading: false,
        error: 'The source audio could not be loaded.',
      },
    });
    const actions: SourceImportAction[] = [];
    fixture.componentInstance.action.subscribe((action) => actions.push(action));
    buttonByText(fixture.nativeElement, 'Retry audio playback').click();

    expect(actions).toEqual([{ type: 'retry-audio' }]);
  });
});

function createFixture(
  overrides: Partial<SourceEvidenceViewModel> = {},
): ReturnType<typeof TestBed.createComponent<SourceEvidencePreviewComponent>> {
  const fixture = TestBed.createComponent(SourceEvidencePreviewComponent);
  fixture.componentRef.setInput('model', {
    document: null,
    chunks: [],
    hiddenChunkCount: 0,
    audio: { url: null, loading: false, error: null },
    transcriptMutationBusy: false,
    ...overrides,
  });
  fixture.detectChanges();
  return fixture;
}

function chunkRead(overrides: Partial<ChunkRead> = {}): ChunkRead {
  return {
    id: 'chunk-1',
    document_id: appDocument.id,
    page_number: 2,
    chunk_index: 0,
    text: 'Readable source excerpt',
    raw_text: 'Readable source excerpt',
    line_start: null,
    line_end: null,
    line_count: 1,
    source_excerpt: 'Readable source excerpt',
    extraction_method: 'text',
    content_profile: 'general',
    created_at: '2026-06-17T00:00:00Z',
    ...overrides,
  };
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  return Array.from(root.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === text,
  ) as HTMLButtonElement;
}
