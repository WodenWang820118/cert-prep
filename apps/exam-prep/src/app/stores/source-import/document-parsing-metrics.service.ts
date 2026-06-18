import { Injectable } from '@angular/core';
import type { DocumentRead } from '../../exam-prep-api';
import type {
  DocumentParsingMetric,
  ParsingMetricDefinition,
} from './contracts/source-import.contracts';

const PARSING_METRIC_DEFINITIONS: readonly ParsingMetricDefinition[] = [
  {
    label: 'Parse wall time',
    kind: 'duration',
    keys: [
      'parse_wall_time_ms',
      'parse_wall_time_seconds',
      'parse_wall_duration_ms',
      'parseWallTimeMs',
      'parseWallDurationMs',
      'parse_duration_ms',
      'parseDurationMs',
      'parse_elapsed_ms',
      'parseElapsedMs',
    ],
  },
  {
    label: 'Render time',
    kind: 'duration',
    keys: [
      'render_time_ms',
      'render_time_seconds',
      'render_duration_ms',
      'renderDurationMs',
      'pdf_render_duration_ms',
      'pdfRenderDurationMs',
      'page_render_time_ms',
      'pageRenderTimeMs',
      'render_ms',
      'renderMs',
    ],
  },
  {
    label: 'OCR engine time',
    kind: 'duration',
    keys: [
      'ocr_engine_time_ms',
      'ocrEngineTimeMs',
      'ocr_engine_duration_ms',
      'ocrEngineDurationMs',
      'ocr_time_ms',
      'ocrTimeMs',
      'ocr_duration_ms',
      'ocrDurationMs',
    ],
  },
  {
    label: 'Worker count',
    kind: 'count',
    keys: [
      'worker_count',
      'workerCount',
      'workers',
      'ocr_worker_count',
      'ocrWorkerCount',
    ],
  },
  {
    label: 'First chunk time',
    kind: 'duration',
    keys: [
      'first_chunk_time_ms',
      'firstChunkTimeMs',
      'first_chunk_duration_ms',
      'firstChunkDurationMs',
      'first_chunk_latency_ms',
      'firstChunkLatencyMs',
      'first_chunk_ms',
      'firstChunkMs',
      'time_to_first_chunk_ms',
      'timeToFirstChunkMs',
    ],
  },
];

/**
 * Owns parsing progress and metric formatting for source document cards.
 */
@Injectable({ providedIn: 'root' })
export class DocumentParsingMetricsService {
  progressPercent(document: DocumentRead | null): number {
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
