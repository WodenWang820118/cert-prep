import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import type { ChunkRead, DocumentRead } from '../../cert-prep-api';
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
      providers: [{ provide: CERT_PREP_API, useValue: apiClient }],
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

  it('loads project documents and makes the latest document active explicitly', async () => {
    const store = TestBed.inject(SourceImportStore);
    const latestDocument = documentRead({ id: 'document-2', filename: 'latest.pdf' });
    apiClient.listDocuments.mockResolvedValue({
      items: [latestDocument, documentRead()],
    });
    apiClient.getDocument.mockResolvedValue(latestDocument);
    apiClient.listDocumentChunks.mockResolvedValue({
      items: [chunkRead({ document_id: latestDocument.id })],
    });

    await store.loadLatestDocument('project-1');

    expect(store.documents()).toEqual([latestDocument, documentRead()]);
    expect(store.activeDocumentId()).toBe(latestDocument.id);
    expect(store.uploadedDocument()).toEqual(latestDocument);
    expect(store.activeDocument()).toEqual(latestDocument);
    expect(store.chunks()).toEqual([chunkRead({ document_id: latestDocument.id })]);
  });

  it('selects a project document and refreshes its status and chunks', async () => {
    const store = TestBed.inject(SourceImportStore);
    const firstDocument = documentRead({ id: 'document-1', filename: 'first.pdf' });
    const secondDocument = documentRead({ id: 'document-2', filename: 'second.pdf' });
    const refreshedSecondDocument = documentRead({
      id: secondDocument.id,
      filename: secondDocument.filename,
      chunks_count: 2,
    });
    store.documents.set([firstDocument, secondDocument]);
    store.setActiveDocumentId(firstDocument.id);
    apiClient.getDocument.mockResolvedValue(refreshedSecondDocument);
    apiClient.listDocumentChunks.mockResolvedValue({
      items: [chunkRead({ document_id: secondDocument.id })],
    });

    await store.selectDocument(secondDocument.id);

    expect(apiClient.getDocument).toHaveBeenCalledWith(
      'project-1',
      secondDocument.id,
    );
    expect(apiClient.listDocumentChunks).toHaveBeenCalledWith(
      'project-1',
      secondDocument.id,
    );
    expect(store.activeDocumentId()).toBe(secondDocument.id);
    expect(store.uploadedDocument()).toEqual(refreshedSecondDocument);
    expect(store.chunks()).toEqual([chunkRead({ document_id: secondDocument.id })]);
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
