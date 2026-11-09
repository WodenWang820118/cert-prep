import type { DocumentRead } from '../../core/domain';

export type SourceDocumentLabel = Pick<DocumentRead, 'id' | 'filename'>;
