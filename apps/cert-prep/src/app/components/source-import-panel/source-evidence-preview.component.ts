import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';
import type { ChunkRead } from '../../contracts/api.contracts';
import type {
  SourceEvidenceViewModel,
  SourceImportAction,
} from './source-import-panel.contracts';

@Component({
  selector: 'app-source-evidence-preview',
  templateUrl: './source-evidence-preview.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class SourceEvidencePreviewComponent {
  readonly model = input.required<SourceEvidenceViewModel>();
  readonly action = output<SourceImportAction>();

  private readonly audioPlayer =
    viewChild<ElementRef<HTMLAudioElement>>('audioPlayer');

  protected formatTimestamp(value: number | null | undefined): string {
    const totalSeconds = Math.max(0, Math.floor((value ?? 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  protected segmentPlaybackLabel(chunk: ChunkRead): string {
    return `Play audio from ${this.formatTimestamp(chunk.start_ms)}`;
  }

  protected playTranscriptChunk(chunk: ChunkRead): void {
    const player = this.audioPlayer()?.nativeElement;
    if (
      player === undefined ||
      this.model().audio.url === null ||
      chunk.start_ms === null ||
      chunk.start_ms === undefined
    ) {
      return;
    }
    player.currentTime = Math.max(0, chunk.start_ms / 1000);
    void player.play().catch(() => {
      // Native controls remain available if autoplay policy blocks play().
    });
  }

  protected retryAudio(): void {
    this.action.emit({ type: 'retry-audio' });
  }

  protected translateStaleTranscript(): void {
    this.action.emit({ type: 'translate-stale-transcript' });
  }

  protected updateTranscript(chunkId: string, text: string): void {
    this.action.emit({
      type: 'update-transcript',
      chunkId,
      text,
    });
  }

  protected translateTranscript(chunkId: string): void {
    this.action.emit({ type: 'translate-transcript', chunkId });
  }

  protected showMoreEvidence(): void {
    this.action.emit({ type: 'show-more-evidence' });
  }
}
