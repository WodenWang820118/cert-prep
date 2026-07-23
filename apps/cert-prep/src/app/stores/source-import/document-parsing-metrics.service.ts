import { Injectable } from '@angular/core';
import type { DocumentRead } from '../../contracts/api.contracts';
import type { DocumentParsingMetric } from './contracts/source-import.contracts';

import { PARSING_METRIC_DEFINITIONS } from './constants/source-import.constants';

/**
 * Owns parsing progress and metric formatting for source document cards.
 */
@Injectable({ providedIn: 'root' })
export class DocumentParsingMetricsService {
  progressPercent(document: DocumentRead | null): number {
    if (document?.source_kind === 'audio') {
      return this.audioProgressPercent(document);
    }
    if (document === null || document.page_count <= 0) {
      return 0;
    }
    const completedPages = this.completedPageCount(document);
    return Math.min(
      100,
      Math.round((completedPages / document.page_count) * 100),
    );
  }

  progressLabel(document: DocumentRead | null): string {
    if (document === null) {
      return '0/0 pages';
    }
    if (document.source_kind === 'audio') {
      return this.audioProgressLabel(document);
    }
    return `${this.completedPageCount(document)}/${document.page_count} pages`;
  }

  elapsedTime(document: DocumentRead | null, now = Date.now()): string {
    if (document === null) {
      return '0s';
    }
    const startedAt = Date.parse(document.created_at);
    if (!Number.isFinite(startedAt)) {
      return '0s';
    }
    const updatedAt = Date.parse(document.updated_at);
    const currentTime =
      document.status === 'processing' || !Number.isFinite(updatedAt)
        ? now
        : updatedAt;
    return this.formatElapsed(currentTime - startedAt);
  }

  parsingMetrics(document: DocumentRead): DocumentParsingMetric[] {
    return PARSING_METRIC_DEFINITIONS.flatMap((definition) => {
      const value = this.readMetricNumber(document, definition.keys);
      if (value === null) {
        return [];
      }

      return [
        {
          label: definition.label,
          value:
            definition.kind === 'duration'
              ? this.formatMetricDuration(value)
              : this.formatMetricCount(value),
        },
      ];
    });
  }

  completedPageCount(document: DocumentRead): number {
    const pageCount = Math.max(0, document.page_count);
    if (pageCount === 0) {
      return 0;
    }

    if (
      document.processed_page_count >= pageCount ||
      (document.status === 'ready' && document.chunks_count >= pageCount)
    ) {
      return pageCount;
    }

    return Math.max(0, Math.min(pageCount, document.processed_page_count));
  }

  private audioProgressPercent(document: DocumentRead): number {
    if (document.status === 'ready') {
      return 100;
    }
    if (document.transcription_status === 'succeeded') {
      return 75;
    }
    if (
      document.status === 'processing' ||
      document.status === 'cancel_requested'
    ) {
      return 25;
    }
    return 0;
  }

  private audioProgressLabel(document: DocumentRead): string {
    if (document.status === 'ready') {
      return document.translation_status === 'failed'
        ? 'Japanese transcript ready / Traditional Chinese translation failed'
        : 'Japanese transcript and Traditional Chinese translation ready';
    }
    if (document.transcription_status === 'succeeded') {
      return document.translation_status === 'failed'
        ? 'Japanese transcript ready / Traditional Chinese translation failed'
        : 'Japanese transcript ready / translating to Traditional Chinese';
    }
    if (document.status === 'cancel_requested') {
      return 'Canceling audio processing';
    }
    if (document.status === 'canceled') {
      return 'Audio processing canceled';
    }
    if (document.status === 'processing') {
      return 'Transcribing Japanese audio';
    }
    return 'Audio processing failed';
  }

  private formatElapsed(milliseconds: number): string {
    const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) {
      return `${seconds}s`;
    }
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  }

  private readMetricNumber(
    document: DocumentRead,
    keys: readonly string[],
  ): number | null {
    const record = document as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return key.endsWith('_seconds') ? value * 1000 : value;
      }
    }

    return null;
  }

  private formatMetricDuration(milliseconds: number): string {
    return `${Math.max(0, Math.round(milliseconds))} ms`;
  }

  private formatMetricCount(count: number): string {
    return Math.max(0, Math.round(count)).toString();
  }
}
