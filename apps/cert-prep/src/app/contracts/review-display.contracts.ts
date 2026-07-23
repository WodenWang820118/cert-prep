import type { DocumentRead } from './api.contracts';

export type SourceDocumentLabel = Pick<DocumentRead, 'id' | 'filename'>;
