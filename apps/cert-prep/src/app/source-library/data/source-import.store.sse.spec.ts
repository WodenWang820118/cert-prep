import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../core/data';
import type {
  ChunkRead,
  SourceOperationRead,
  SourceRead,
} from '../../core/domain';
import type { SourceOperationEvent } from '../../core/domain';
import { CertPrepSseClient } from '../../core/data';
import { provideCertPrepHttpResourceClientFake } from '../../core/testing';
import { ProjectStore } from '../../projects/data';
import { SourceImportStore } from './source-import.store';
import { of, Subject } from 'rxjs';

describe('SourceImportStore source SSE chunks', () => {
  const apiClient = {
    getSource: vi.fn(),
    listSourceChunks: vi.fn(),
  };
  const sseClient = { streamJson: vi.fn() };
  let operationStream: Subject<SourceOperationEvent>;

  beforeEach(() => {
    vi.clearAllMocks();
    operationStream = new Subject<SourceOperationEvent>();
    sseClient.streamJson.mockReturnValue(operationStream.asObservable());
    apiClient.getSource.mockReturnValue(of(sourceRead()));

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
    const source = sourceRead();
    const requests: Subject<{ items: ChunkRead[] }>[] = [];
    let requestCount = 0;
    apiClient.listSourceChunks.mockImplementation(() => {
      requestCount += 1;
      if (requestCount === 1) return of({ items: [] });
      const request = new Subject<{ items: ChunkRead[] }>();
      requests.push(request);
      return request.asObservable();
    });

    store.sources.set([source]);
    store.setActiveSourceId(source.id);
    store.refreshUploadedSource('project-1', source.id);
    TestBed.tick();

    operationStream.next(operationEvent(sourceRead({ status: 'processing' }), 'running'));
    TestBed.tick();
    operationStream.next(
      operationEvent(
        sourceRead({ status: 'ready', chunks_count: 2 }),
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

function sourceRead(overrides: Partial<SourceRead> = {}): SourceRead {
  return {
    id: 'source-1',
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
  } as SourceRead;
}

function operationEvent(
  source: SourceRead,
  status: SourceOperationRead['status'],
): SourceOperationEvent {
  return {
    operation: {
      id: `operation-${status}`,
      project_id: 'project-1',
      source_id: source.id,
      status,
      phase: status === 'succeeded' ? 'completed' : 'processing',
      cancellable: status !== 'succeeded',
      error: null,
      created_at: '2026-06-09T00:00:00Z',
      updated_at: '2026-06-09T00:00:01Z',
    },
    source,
  };
}

function chunk(id: string): ChunkRead {
  return {
    id,
    source_id: 'source-1',
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
