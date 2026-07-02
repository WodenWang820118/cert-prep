import { computed, Injectable, signal } from '@angular/core';
import type { ChunkRead, DocumentRead } from '../../cert-prep-api';

const INITIAL_CHUNK_PREVIEW_LIMIT = 6;
const CHUNK_PREVIEW_STEP = 6;

@Injectable({ providedIn: 'root' })
export class DocumentLibraryStore {
  readonly documents = signal<DocumentRead[]>([]);
  readonly activeDocumentId = signal<string | null>(null);
  readonly uploadedDocument = signal<DocumentRead | null>(null);
  readonly chunks = signal<ChunkRead[]>([]);
  readonly visibleChunkLimit = signal(INITIAL_CHUNK_PREVIEW_LIMIT);
  readonly activeDocument = computed(() => {
    const activeId = this.activeDocumentId();
    const uploaded = this.uploadedDocument();
    if (activeId === null) {
      return uploaded;
    }

    return (
      this.documents().find((document) => document.id === activeId) ??
      (uploaded?.id === activeId ? uploaded : null)
    );
  });
  readonly activeDocumentSelectValue = computed(
    () => this.activeDocumentId() ?? '',
  );
  readonly previewChunks = computed(() =>
    this.chunks().slice(0, this.visibleChunkLimit()),
  );
  readonly hiddenChunkCount = computed(() =>
    Math.max(0, this.chunks().length - this.previewChunks().length),
  );

  reset(): void {
    this.documents.set([]);
    this.clearActiveDocument();
  }

  clearActiveDocument(): void {
    this.activeDocumentId.set(null);
    this.uploadedDocument.set(null);
    this.clearChunks();
  }

  clearChunks(): void {
    this.chunks.set([]);
    this.visibleChunkLimit.set(INITIAL_CHUNK_PREVIEW_LIMIT);
  }

  showMoreChunks(): void {
    this.visibleChunkLimit.update((limit) => limit + CHUNK_PREVIEW_STEP);
  }

  setDocuments(documents: DocumentRead[]): void {
    this.documents.set(documents);
  }

  setChunks(chunks: ChunkRead[]): void {
    this.chunks.set(chunks);
  }

  chooseActiveFromDocuments(): DocumentRead | null {
    return (
      this.documents().find(
        (document) => document.id === this.activeDocumentId(),
      ) ??
      this.documents()[0] ??
      null
    );
  }

  setActiveDocumentId(documentId: string | null): boolean {
    if (documentId === null) {
      return this.setActiveDocument(null);
    }

    const document = this.documents().find((item) => item.id === documentId);
    if (document === undefined) {
      return false;
    }

    return this.setActiveDocument(document);
  }

  setActiveDocument(document: DocumentRead | null): boolean {
    const nextDocumentId = document?.id ?? null;
    const changed = this.activeDocumentId() !== nextDocumentId;
    if (changed) {
      this.clearChunks();
    }
    this.activeDocumentId.set(nextDocumentId);
    this.uploadedDocument.set(document);
    return changed;
  }

  upsertDocument(document: DocumentRead): void {
    this.documents.update((documents) => {
      const existingIndex = documents.findIndex(
        (item) => item.id === document.id,
      );
      if (existingIndex === -1) {
        return [document, ...documents];
      }

      return documents.map((item, index) =>
        index === existingIndex ? document : item,
      );
    });
  }
}
