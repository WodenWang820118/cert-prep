import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { Tag } from 'primeng/tag';
import type {
  SourceDocumentStatusViewModel,
  SourceImportAction,
} from './source-import-panel.contracts';

@Component({
  selector: 'app-source-document-status',
  imports: [Tag],
  templateUrl: './source-document-status.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class SourceDocumentStatusComponent {
  readonly model = input.required<SourceDocumentStatusViewModel>();
  readonly action = output<SourceImportAction>();

  protected readonly readyForReview = computed(() => {
    const document = this.model().document;
    return (
      document !== null &&
      document.status === 'ready' &&
      document.has_text &&
      document.chunks_count > 0
    );
  });

  protected documentStatusLabel(): string {
    const document = this.model().document;
    if (document === null) {
      return 'No source selected';
    }
    if (this.readyForReview()) {
      return 'Ready to review';
    }
    switch (document.status) {
      case 'processing':
        return 'Preparing source evidence';
      case 'cancel_requested':
        return 'Stopping source preparation';
      case 'canceled':
        return 'Source preparation canceled';
      case 'no_text_detected':
        return 'No reviewable text found';
      case 'ocr_failed':
        return 'Source could not be read';
      case 'transcription_failed':
        return 'Audio transcription failed';
      default:
        return 'Source needs attention';
    }
  }

  protected documentStatusSeverity(): 'success' | 'info' | 'warn' | 'danger' {
    const document = this.model().document;
    if (this.readyForReview()) {
      return 'success';
    }
    if (document?.status === 'processing') {
      return 'info';
    }
    if (
      document?.status === 'ocr_failed' ||
      document?.status === 'transcription_failed'
    ) {
      return 'danger';
    }
    return 'warn';
  }

  protected statusGuidance(): string {
    const document = this.model().document;
    if (document === null) {
      return 'Choose a source file to check whether its evidence is ready.';
    }
    if (this.readyForReview()) {
      return 'Source evidence is ready to inspect below. Continue to Draft Review when you are ready.';
    }
    if (document.status === 'processing' && document.chunks_count > 0) {
      return 'Some source evidence is available below while preparation continues.';
    }
    if (document.status === 'no_text_detected') {
      return 'The source was accepted, but no reviewable text was found.';
    }
    return 'Resolve the source issue or retry processing before reviewing evidence.';
  }

  protected sourceWarning(): string | null {
    const document = this.model().document;
    if (
      document?.transcription_warning !== null &&
      document?.transcription_warning !== undefined
    ) {
      return 'Some audio segments need a quick review before practice.';
    }
    if (
      document?.ocr_fallback_reason !== null &&
      document?.ocr_fallback_reason !== undefined
    ) {
      return 'The source was prepared with a fallback reader. Check the evidence before practice.';
    }
    return null;
  }

  protected selectDocument(documentId: string): void {
    this.action.emit({ type: 'select-document', documentId });
  }

  protected cancelProcessing(): void {
    this.action.emit({ type: 'cancel-processing' });
  }

  protected retryProcessing(): void {
    this.action.emit({ type: 'retry-processing' });
  }

  protected retryProgress(): void {
    this.action.emit({ type: 'retry-progress' });
  }

  protected canCancelProcessing(): boolean {
    const status = this.model().document?.status;
    return status === 'processing' || status === 'cancel_requested';
  }

  protected canRetryProcessing(): boolean {
    return [
      'canceled',
      'ocr_failed',
      'transcription_failed',
      'no_text_detected',
      'exam_failed',
    ].includes(this.model().document?.status ?? '');
  }
}
