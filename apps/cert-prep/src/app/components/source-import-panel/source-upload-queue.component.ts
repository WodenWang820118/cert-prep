import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Tag } from 'primeng/tag';
import { ToggleSwitch } from 'primeng/toggleswitch';
import type {
  SourceImportAction,
  SourceUploadQueueViewModel,
} from './source-import-panel.contracts';

@Component({
  selector: 'app-source-upload-queue',
  imports: [FormsModule, Tag, ToggleSwitch],
  templateUrl: './source-upload-queue.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class SourceUploadQueueComponent {
  readonly model = input.required<SourceUploadQueueViewModel>();
  readonly action = output<SourceImportAction>();

  private readonly chooseFilesControl =
    viewChild<ElementRef<HTMLLabelElement>>('chooseFilesControl');

  focusChooseFiles(): void {
    this.chooseFilesControl()?.nativeElement.focus();
  }

  protected chooseFiles(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    this.action.emit({ type: 'choose-files', files });
  }

  protected setCropImagesBeforeUpload(enabled: boolean): void {
    this.action.emit({ type: 'set-crop-images', enabled });
  }

  protected setLanguage(value: string): void {
    const language = this.model().languageHints.find(
      (candidate) => candidate === value,
    );
    if (language !== undefined) {
      this.action.emit({ type: 'set-language', value: language });
    }
  }

  protected languageLabel(language: string): string {
    switch (language) {
      case 'ja':
        return 'Japanese';
      case 'zh-Hant':
        return 'Traditional Chinese';
      case 'zh-Hans':
        return 'Simplified Chinese';
      case 'en':
        return 'English';
      case 'mixed':
        return 'Mixed languages';
      default:
        return 'Auto-detect';
    }
  }

  protected upload(): void {
    this.action.emit({ type: 'upload' });
  }

  protected cancelUpload(itemId: string): void {
    this.action.emit({ type: 'cancel-upload', itemId });
  }

  protected retryUpload(itemId: string): void {
    this.action.emit({ type: 'retry-upload', itemId });
  }

  protected uploadStatusLabel(status: string): string {
    switch (status) {
      case 'queued':
        return 'Waiting to upload';
      case 'uploading':
        return 'Uploading';
      case 'uploaded':
        return 'Uploaded';
      case 'cancel_requested':
        return 'Canceling';
      case 'canceled':
        return 'Canceled';
      case 'status_unavailable':
        return 'Needs retry';
      default:
        return 'Upload failed';
    }
  }

  protected uploadStatusSeverity(
    status: string,
  ): 'success' | 'info' | 'warn' | 'danger' {
    if (status === 'uploaded') {
      return 'success';
    }
    if (status === 'uploading') {
      return 'info';
    }
    if (status === 'failed') {
      return 'danger';
    }
    return 'warn';
  }

  protected canCancel(item: SourceUploadQueueViewModel['items'][number]): boolean {
    return (
      ['queued', 'uploading', 'cancel_requested'].includes(item.status) ||
      (item.status === 'uploaded' &&
        ['processing', 'cancel_requested'].includes(item.document?.status ?? ''))
    );
  }

  protected canRetry(item: SourceUploadQueueViewModel['items'][number]): boolean {
    return (
      item.status === 'status_unavailable' ||
      (item.document === null && ['failed', 'canceled'].includes(item.status))
    );
  }
}
