import { computed, Injectable, signal } from '@angular/core';
import type { ChunkRead, SourceRead } from '../../core/domain';
import { CHUNK_PREVIEW_STEP, INITIAL_CHUNK_PREVIEW_LIMIT } from '../domain';

@Injectable({ providedIn: 'root' })
export class SourceLibraryStore {
  readonly sources = signal<SourceRead[]>([]);
  readonly activeSourceId = signal<string | null>(null);
  readonly uploadedSource = signal<SourceRead | null>(null);
  readonly chunks = signal<ChunkRead[]>([]);
  readonly visibleChunkLimit = signal(INITIAL_CHUNK_PREVIEW_LIMIT);
  readonly activeSource = computed(() => {
    const activeId = this.activeSourceId();
    const uploaded = this.uploadedSource();
    if (activeId === null) {
      return uploaded;
    }

    return (
      this.sources().find((source) => source.id === activeId) ??
      (uploaded?.id === activeId ? uploaded : null)
    );
  });
  readonly activeSourceSelectValue = computed(
    () => this.activeSourceId() ?? '',
  );
  readonly previewChunks = computed(() =>
    this.chunks().slice(0, this.visibleChunkLimit()),
  );
  readonly hiddenChunkCount = computed(() =>
    Math.max(0, this.chunks().length - this.previewChunks().length),
  );

  reset(): void {
    this.sources.set([]);
    this.clearActiveSource();
  }

  clearActiveSource(): void {
    this.activeSourceId.set(null);
    this.uploadedSource.set(null);
    this.clearChunks();
  }

  clearChunks(): void {
    this.chunks.set([]);
    this.visibleChunkLimit.set(INITIAL_CHUNK_PREVIEW_LIMIT);
  }

  showMoreChunks(): void {
    this.visibleChunkLimit.update((limit) => limit + CHUNK_PREVIEW_STEP);
  }

  setSources(sources: SourceRead[]): void {
    this.sources.set(sources);
  }

  setChunks(chunks: ChunkRead[]): void {
    this.chunks.set(chunks);
  }

  chooseActiveFromSources(): SourceRead | null {
    return (
      this.sources().find(
        (source) => source.id === this.activeSourceId(),
      ) ??
      this.sources()[0] ??
      null
    );
  }

  setActiveSourceId(sourceId: string | null): boolean {
    if (sourceId === null) {
      return this.setActiveSource(null);
    }

    const source = this.sources().find((item) => item.id === sourceId);
    if (source === undefined) {
      return false;
    }

    return this.setActiveSource(source);
  }

  setActiveSource(source: SourceRead | null): boolean {
    const nextSourceId = source?.id ?? null;
    const changed = this.activeSourceId() !== nextSourceId;
    if (changed) {
      this.clearChunks();
    }
    this.activeSourceId.set(nextSourceId);
    this.uploadedSource.set(source);
    return changed;
  }

  upsertSource(source: SourceRead): void {
    this.sources.update((sources) => {
      const existingIndex = sources.findIndex(
        (item) => item.id === source.id,
      );
      if (existingIndex === -1) {
        return [source, ...sources];
      }

      return sources.map((item, index) =>
        index === existingIndex ? source : item,
      );
    });
  }
}
