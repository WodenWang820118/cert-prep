import { TestBed } from '@angular/core/testing';
import { EXAM_PREP_API } from '../../exam-prep-api';
import type { ChunkRead, DocumentRead } from '../../exam-prep-api';
import { ProjectStore } from '../project.store';
import { SourceImportStore } from './source-import.store';

describe('SourceImportStore polling', () => {
  const apiClient = {
    getDocument: vi.fn(),
    listDocumentChunks: vi.fn(),
    listDocuments: vi.fn(),
    uploadDocument: vi.fn(),
    health: vi.fn(),
    llmHealth: vi.fn(),
    ocrHealth: vi.fn(),
    runtimeRequirements: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [{ provide: EXAM_PREP_API, useValue: apiClient }],
    });

    const projects = TestBed.inject(ProjectStore);
    projects.projects.set([
      {
        id: 'project-1',
        name: 'Runtime QA',
        description: '',
        created_at: '2026-06-18T00:00:00Z',
        updated_at: '2026-06-18T00:00:00Z',
      },
    ]);
    projects.select('project-1');
  });

  afterEach(() => {
    TestBed.inject(SourceImportStore).reset();
    vi.useRealTimers();
  });

  it('polls quickly until the first chunk is visible, then returns to the normal cadence', async () => {
    const store = TestBed.inject(SourceImportStore);
    apiClient.getDocument
      .mockResolvedValueOnce(
        documentRead({ status: 'processing', chunks_count: 1 }),
      )
      .mockResolvedValueOnce(
        documentRead({ status: 'processing', chunks_count: 1 }),
      )
      .mockResolvedValueOnce(
        documentRead({ status: 'processing', chunks_count: 1 }),
      );
    apiClient.listDocumentChunks
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [chunkRead()] })
      .mockResolvedValueOnce({ items: [chunkRead()] });

    await store.refreshUploadedDocument('project-1', 'document-1');

    expect(store.chunks()).toEqual([]);
    expect(apiClient.getDocument).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(499);
    expect(apiClient.getDocument).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(apiClient.getDocument).toHaveBeenCalledTimes(2);
    expect(store.chunks()).toEqual([chunkRead()]);

    await vi.advanceTimersByTimeAsync(1499);
    expect(apiClient.getDocument).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(apiClient.getDocument).toHaveBeenCalledTimes(3);
  });
});

function documentRead(overrides: Partial<DocumentRead> = {}): DocumentRead {
  return {
    id: 'document-1',
    project_id: 'project-1',
    filename: 'runtime.pdf',
    sha256: 'document-sha',
    language_hint: 'en',
    page_count: 8,
    has_text: true,
    status: 'ready',
    extraction_method: 'paddle_ocr_gpu',
    ocr_device: 'gpu:0',
    ocr_fallback_reason: null,
    ocr_duration_ms: 222,
    processed_page_count: 8,
    parse_wall_duration_ms: 0,
    render_duration_ms: 0,
    ocr_engine_duration_ms: 222,
    ocr_worker_count: 1,
    first_chunk_ms: 0,
    exam_item_count: 0,
    content_profile: 'unknown',
    classification_detail: '',
    chunks_count: 8,
    created_at: '2026-06-18T00:00:00Z',
    updated_at: '2026-06-18T00:00:01Z',
    ...overrides,
  };
}

function chunkRead(overrides: Partial<ChunkRead> = {}): ChunkRead {
  return {
    id: 'chunk-1',
    document_id: 'document-1',
    page_number: 1,
    chunk_index: 0,
    text: 'Visible OCR text.',
    raw_text: 'Visible OCR text.',
    line_start: null,
    line_end: null,
    line_count: 1,
    source_excerpt: 'Visible OCR text.',
    extraction_method: 'paddle_ocr_gpu',
    content_profile: 'unknown',
    created_at: '2026-06-18T00:00:00Z',
    ...overrides,
  };
}
