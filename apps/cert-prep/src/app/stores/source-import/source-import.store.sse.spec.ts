import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../constants/cert-prep-api.constants';
import type {
  ChunkRead,
  DocumentOperationRead,
  DocumentRead,
} from '../../contracts/api.contracts';
import type { DocumentOperationEvent } from '../../contracts/operation-events.contracts';
import { CertPrepSseClient } from '../../services/cert-prep-sse-client.service';
import { provideCertPrepHttpResourceClientFake } from '../../testing/cert-prep-http-resource-client.fake';
import { ProjectStore } from '../project.store';
import { SourceImportStore } from './source-import.store';
import { of, Subject } from 'rxjs';

describe('SourceImportStore document SSE chunks', () => {
  const apiClient = {
    getDocument: vi.fn(),
    listDocumentChunks: vi.fn(),
  };
  const sseClient = { streamJson: vi.fn() };
  let operationStream: Subject<DocumentOperationEvent>;

  beforeEach(() => {
    vi.clearAllMocks();
    operationStream = new Subject<DocumentOperationEvent>();
    sseClient.streamJson.mockReturnValue(operationStream.asObservable());
    apiClient.getDocument.mockReturnValue(of(documentRead()));

    TestBed.configureTestingModule({
      providers: [
        { provide: CERT_PREP_API, useValue: apiClient },
        { provide: CertPrepSseClient, useValue: sseClient },
        provideCertPrepHttpResourceClientFake(apiClient),
      ],
    });

    const projects = TestBed.inject(ProjectStore);
    projects.projects.set([
      {
        id: 'project-1',
        name: 'JLPT N1',
        description: '',
        created_at: '2026-06-09T00:00:00Z',
        updated_at: '2026-06-09T00:00:00Z',
      },
    ]);
    projects.select('project-1');
  });

  it('ignores an older chunk response after a newer terminal event requests chunks', () => {
    const store = TestBed.inject(SourceImportStore);
    const document = documentRead();
    const requests: Subject<{ items: ChunkRead[] }>[] = [];
    let requestCount = 0;
    apiClient.listDocumentChunks.mockImplementation(() => {
      requestCount += 1;
      if (requestCount === 1) return of({ items: [] });
      const request = new Subject<{ items: ChunkRead[] }>();
      requests.push(request);
      return request.asObservable();
    });

    store.documents.set([document]);
    store.setActiveDocumentId(document.id);
    store.refreshUploadedDocument('project-1', document.id);
    TestBed.tick();

    operationStream.next(operationEvent(documentRead({ status: 'processing' }), 'running'));
    TestBed.tick();
    operationStream.next(
      operationEvent(
        documentRead({ status: 'ready', chunks_count: 2 }),
        'succeeded',
      ),
    );
    TestBed.tick();

    expect(requests).toHaveLength(2);
    requests[0]?.next({ items: [chunk('stale')] });
    requests[0]?.complete();
    TestBed.tick();
    expect(store.chunks()).toEqual([]);

    requests[1]?.next({ items: [chunk('latest')] });
    requests[1]?.complete();
    TestBed.tick();
    expect(store.chunks().map((item) => item.id)).toEqual(['latest']);
  });
});

function documentRead(overrides: Partial<DocumentRead> = {}): DocumentRead {
  return {
    id: 'document-1',
    project_id: 'project-1',
    filename: 'guide.pdf',
    source_kind: 'pdf',
    status: 'processing',
    has_text: true,
    page_count: 1,
    processed_page_count: 1,
    chunks_count: 1,
    created_at: '2026-06-09T00:00:00Z',
    updated_at: '2026-06-09T00:00:01Z',
    ...overrides,
  } as DocumentRead;
}

function operationEvent(
  document: DocumentRead,
  status: DocumentOperationRead['status'],
): DocumentOperationEvent {
  return {
    operation: {
      id: `operation-${status}`,
      project_id: 'project-1',
      document_id: document.id,
      status,
      phase: status === 'succeeded' ? 'completed' : 'processing',
      cancellable: status !== 'succeeded',
      error: null,
      created_at: '2026-06-09T00:00:00Z',
      updated_at: '2026-06-09T00:00:01Z',
    },
    document,
  };
}

function chunk(id: string): ChunkRead {
  return {
    id,
    document_id: 'document-1',
    page_number: 1,
    chunk_index: 0,
    text: id,
    raw_text: id,
    line_start: 1,
    line_end: 1,
    line_count: 1,
    source_excerpt: id,
    extraction_method: 'text',
    content_profile: 'general',
    created_at: '2026-06-09T00:00:01Z',
    translated_text: null,
  };
}
