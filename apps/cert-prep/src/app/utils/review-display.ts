import type { DocumentRead } from '../cert-prep-api';

type SourceDocumentLabel = Pick<DocumentRead, 'id' | 'filename'>;

export function documentLabel(
  documents: readonly SourceDocumentLabel[],
  documentId: string | null,
): string | null {
  if (documentId === null) {
    return null;
  }
  return (
    documents.find((document) => document.id === documentId)?.filename ??
    documentId
  );
}

export function requiredDocumentLabel(
  documents: readonly SourceDocumentLabel[],
  documentId: string | null,
): string {
  return documentLabel(documents, documentId) ?? 'No source document';
}

export function pageLabel(page: number | null): string {
  return page === null ? 'Page n/a' : `Page ${page}`;
}

export function reviewDateLabel(value: string | null): string {
  return value === null ? 'None' : value.slice(0, 10);
}
