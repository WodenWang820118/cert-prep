import type { DocumentOperationRead } from '../../cert-prep-api';
import { isExpectedDocumentOperation } from './document-operation-snapshot';

describe('isExpectedDocumentOperation', () => {
  it.each(['processing', 'transcribing', 'translating'] as const)(
    'accepts the cancellable running %s phase',
    (phase) => {
      expect(
        isExpectedDocumentOperation(
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
        isExpectedDocumentOperation(
          operationRead({ phase, cancellable: false }),
          'operation-1',
          'project-1',
        ),
      ).toBe(false);
    },
  );
});

function operationRead(
  overrides: Partial<DocumentOperationRead> = {},
): DocumentOperationRead {
  return {
    id: 'operation-1',
    project_id: 'project-1',
    document_id: 'document-1',
    status: 'running',
    phase: 'processing',
    cancellable: true,
    error: null,
    created_at: '2026-07-19T00:00:00Z',
    updated_at: '2026-07-19T00:00:01Z',
    ...overrides,
  };
}
