import { Injectable } from '@angular/core';
import type { SourceRead } from '../../core/domain';
import { namedSourceLanguage } from '../domain';

/**
 * Owns source preparation progress and elapsed time for source cards.
 */
@Injectable({ providedIn: 'root' })
export class SourcePreparationMetricsService {
  progressPercent(source: SourceRead | null): number {
    if (source?.source_kind === 'recording') {
      return this.audioProgressPercent(source);
    }
    if (source === null || source.page_count <= 0) {
      return 0;
    }
    const completedPages = this.completedPageCount(source);
    return Math.min(
      100,
      Math.round((completedPages / source.page_count) * 100),
    );
  }

  progressLabel(source: SourceRead | null): string {
    if (source === null) {
      return '0/0 pages';
    }
    if (source.source_kind === 'recording') {
      return this.audioProgressLabel(source);
    }
    return `${this.completedPageCount(source)}/${source.page_count} pages`;
  }

  elapsedTime(source: SourceRead | null, now = Date.now()): string {
    if (source === null) {
      return '0s';
    }
    const startedAt = Date.parse(source.created_at);
    if (!Number.isFinite(startedAt)) {
      return '0s';
    }
    const updatedAt = Date.parse(source.updated_at);
    const currentTime =
      source.status === 'processing' || !Number.isFinite(updatedAt)
        ? now
        : updatedAt;
    return this.formatElapsed(currentTime - startedAt);
  }

  completedPageCount(source: SourceRead): number {
    const pageCount = Math.max(0, source.page_count);
    if (pageCount === 0) {
      return 0;
    }

    if (
      source.processed_page_count >= pageCount ||
      (source.status === 'ready' && source.chunks_count >= pageCount)
    ) {
      return pageCount;
    }

    return Math.max(0, Math.min(pageCount, source.processed_page_count));
  }

  private audioProgressPercent(source: SourceRead): number {
    if (source.status === 'ready') {
      return 100;
    }
    if (source.transcription_status === 'succeeded') {
      return 75;
    }
    if (
      source.status === 'processing' ||
      source.status === 'cancel_requested'
    ) {
      return 25;
    }
    return 0;
  }

  private audioProgressLabel(source: SourceRead): string {
    const language = namedSourceLanguage(source.language_hint);
    const transcript = language ? `${language} transcript` : 'Transcript';
    if (source.status === 'ready') {
      return source.translation_status === 'failed'
        ? `${transcript} ready / Traditional Chinese translation failed`
        : `${transcript} and Traditional Chinese translation ready`;
    }
    if (source.transcription_status === 'succeeded') {
      return source.translation_status === 'failed'
        ? `${transcript} ready / Traditional Chinese translation failed`
        : `${transcript} ready / translating to Traditional Chinese`;
    }
    if (source.status === 'cancel_requested') {
      return 'Canceling recording processing';
    }
    if (source.status === 'canceled') {
      return 'Recording processing canceled';
    }
    if (source.status === 'processing') {
      return language ? `Transcribing ${language} recording` : 'Transcribing recording';
    }
    return 'Recording processing failed';
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
}
