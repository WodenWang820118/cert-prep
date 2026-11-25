import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import type {
  SourceStatusViewModel,
  SourceImportAction,
} from '../../domain';
import { AppIconComponent } from '../../../core/ui';
import { HlmBadge } from '@spartan-ng/helm/badge';

// Only a failed source explains its failure; a source that became ready again may still
// carry the message of an earlier run.
const FAILURE_STATUSES: ReadonlySet<string> = new Set([
  'extraction_failed',
  'no_text_detected',
  'transcription_failed',
]);

@Component({
  selector: 'app-source-status',
  imports: [AppIconComponent, HlmBadge],
  templateUrl: './source-status.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class SourceStatusComponent {
  readonly model = input.required<SourceStatusViewModel>();
  readonly action = output<SourceImportAction>();

  protected readonly readyForReview = computed(() => {
    const source = this.model().source;
    return (
      source !== null &&
      source.status === 'ready' &&
      source.has_text &&
      source.chunks_count > 0
    );
  });

  protected sourceStatusLabel(): string {
    const source = this.model().source;
    if (source === null) {
      return 'No source selected';
    }
    if (this.readyForReview()) {
      return 'Ready to review';
    }
    switch (source.status) {
      case 'processing':
        return 'Preparing source evidence';
      case 'cancel_requested':
        return 'Stopping source preparation';
      case 'canceled':
        return 'Source preparation canceled';
      case 'no_text_detected':
        return 'No reviewable text found';
      case 'extraction_failed':
        return 'Source could not be read';
      case 'transcription_failed':
        return 'Recording transcription failed';
      default:
        return 'Source needs attention';
    }
  }

  protected sourceStatusSeverity(): 'success' | 'info' | 'warn' | 'danger' {
    const source = this.model().source;
    if (this.readyForReview()) {
      return 'success';
    }
    if (source?.status === 'processing') {
      return 'info';
    }
    if (
      source?.status === 'extraction_failed' ||
      source?.status === 'transcription_failed'
    ) {
      return 'danger';
    }
    return 'warn';
  }

  protected statusGuidance(): string {
    const source = this.model().source;
    if (source === null) {
      return 'Choose a source file to check whether its evidence is ready.';
    }
    if (this.readyForReview()) {
      return 'Source evidence is ready to inspect below. Continue to Questions when you are ready.';
    }
    if (source.status === 'processing' && source.chunks_count > 0) {
      return 'Some source evidence is available below while preparation continues.';
    }
    if (source.status === 'no_text_detected') {
      return 'The source was accepted, but no reviewable text was found.';
    }
    return 'Resolve the source issue or retry processing before reviewing evidence.';
  }

  protected sourceWarning(): string | null {
    const source = this.model().source;
    if (
      source?.transcription_warning !== null &&
      source?.transcription_warning !== undefined
    ) {
      return 'Some recording segments need a quick review before practice.';
    }
    if (source?.status === 'ready' && source.extraction_warnings) {
      return 'Check the extracted text before practice.';
    }
    return null;
  }

  protected failureMessage(): string | null {
    const source = this.model().source;
    if (source === null || !FAILURE_STATUSES.has(source.status)) {
      return null;
    }
    return source.failure_message ?? null;
  }

  protected selectSource(sourceId: string): void {
    this.action.emit({ type: 'select-source', sourceId });
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
    const status = this.model().source?.status;
    return status === 'processing' || status === 'cancel_requested';
  }

  protected canRetryProcessing(): boolean {
    return [
      'canceled',
      'extraction_failed',
      'transcription_failed',
      'no_text_detected',
    ].includes(this.model().source?.status ?? '');
  }
}
