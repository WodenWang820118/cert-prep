import { TestBed } from '@angular/core/testing';
import type { SourceOperationRead } from '../../core/domain';
import { SourceOperationSnapshotService } from './source-operation-snapshot.service';

describe('SourceOperationSnapshotService', () => {
  let service: SourceOperationSnapshotService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(SourceOperationSnapshotService);
  });

  it.each(['processing', 'transcribing', 'translating'] as const)(
    'accepts the cancellable running %s phase',
    (phase) => {
      expect(
        service.isExpectedSourceOperation(
          operationRead({ phase }),
          'operation-1',
          'project-1',
        ),
      ).toBe(true);
    },
  );

  it.each(['transcribing', 'translating'] as const)(
    'rejects a non-cancellable running %s phase',
    (phase) => {
      expect(
        service.isExpectedSourceOperation(
          operationRead({ phase, cancellable: false }),
          'operation-1',
          'project-1',
        ),
      ).toBe(false);
    },
  );
});

function operationRead(
  overrides: Partial<SourceOperationRead> = {},
): SourceOperationRead {
  return {
    id: 'operation-1',
    project_id: 'project-1',
    source_id: 'source-1',
    status: 'running',
    phase: 'processing',
    cancellable: true,
    error: null,
    created_at: '2026-07-19T00:00:00Z',
    updated_at: '2026-07-19T00:00:01Z',
    ...overrides,
  };
}
