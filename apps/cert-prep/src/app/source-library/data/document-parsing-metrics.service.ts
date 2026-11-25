import { Injectable } from '@angular/core';
import type { DocumentRead } from '../../core/domain';
import { namedSourceLanguage } from '../domain';

/**
 * Owns source preparation progress and elapsed time for source document cards.
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
    const language = namedSourceLanguage(document.language_hint);
    const transcript = language ? `${language} transcript` : 'Transcript';
    if (document.status === 'ready') {
      return document.translation_status === 'failed'
        ? `${transcript} ready / Traditional Chinese translation failed`
        : `${transcript} and Traditional Chinese translation ready`;
    }
    if (document.transcription_status === 'succeeded') {
      return document.translation_status === 'failed'
        ? `${transcript} ready / Traditional Chinese translation failed`
        : `${transcript} ready / translating to Traditional Chinese`;
    }
    if (document.status === 'cancel_requested') {
      return 'Canceling audio processing';
    }
    if (document.status === 'canceled') {
      return 'Audio processing canceled';
    }
    if (document.status === 'processing') {
      return language ? `Transcribing ${language} audio` : 'Transcribing audio';
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
}
