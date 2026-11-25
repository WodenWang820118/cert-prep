import { Injectable } from '@angular/core';
import type { SourceLabel } from '../domain';

@Injectable({ providedIn: 'root' })
export class ReviewDisplayService {
  sourceLabel(
    sources: readonly SourceLabel[],
    sourceId: string | null,
  ): string | null {
    if (sourceId === null) {
      return null;
    }
    return (
      sources.find((source) => source.id === sourceId)?.filename ??
      sourceId
    );
  }

  requiredSourceLabel(
    sources: readonly SourceLabel[],
    sourceId: string | null,
  ): string {
    return this.sourceLabel(sources, sourceId) ?? 'No source';
  }

  pageLabel(page: number | null): string {
    return page === null ? 'Page n/a' : `Page ${page}`;
  }

  reviewDateLabel(value: string | null): string {
    return value === null ? 'None' : value.slice(0, 10);
  }
}
