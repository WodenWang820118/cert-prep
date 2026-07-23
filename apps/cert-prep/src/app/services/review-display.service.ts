import { Injectable } from '@angular/core';
import type { SourceDocumentLabel } from '../contracts/review-display.contracts';

@Injectable({ providedIn: 'root' })
export class ReviewDisplayService {
  documentLabel(
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

  requiredDocumentLabel(
    documents: readonly SourceDocumentLabel[],
    documentId: string | null,
  ): string {
    return this.documentLabel(documents, documentId) ?? 'No source document';
  }

  pageLabel(page: number | null): string {
    return page === null ? 'Page n/a' : `Page ${page}`;
  }

  reviewDateLabel(value: string | null): string {
    return value === null ? 'None' : value.slice(0, 10);
  }
}
