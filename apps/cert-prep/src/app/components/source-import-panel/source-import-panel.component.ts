import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ProgressBar } from 'primeng/progressbar';
import { Tag } from 'primeng/tag';
import { DraftReviewStore } from '../../stores/draft-review/draft-review.store';
import { OperationStore } from '../../stores/operation.store';
import { ProjectStore } from '../../stores/project.store';
import { SourceImportStore } from '../../stores/source-import/source-import.store';

@Component({
  selector: 'app-source-import-panel',
  imports: [FormsModule, ProgressBar, Tag],
  template: `
    <section class="workbench-panel" aria-labelledby="source-heading">
      <header class="workbench-panel-header">
        <div class="workbench-panel-title">
          <span class="workbench-panel-icon" aria-hidden="true">
            <i class="pi pi-file"></i>
          </span>
          <h2 id="source-heading">Step 01: Source files</h2>
        </div>
        <label
          class="workbench-secondary-button"
          [attr.for]="isUploadBusy() ? null : 'sourceFiles'"
          [attr.aria-disabled]="isUploadBusy()"
        >
          <i class="pi pi-upload" aria-hidden="true"></i>
          <span>Choose files</span>
        </label>
      </header>

      <div class="workbench-panel-body">
        <input
          id="sourceFiles"
          class="sr-only"
          type="file"
          [accept]="sourceImport.sourceFileAccept"
          multiple
          aria-label="Source files"
          [disabled]="isUploadBusy()"
          (change)="chooseFiles($event)"
        />

        <div class="workbench-file-row">
          <div class="workbench-file-name">
            <i class="pi pi-file" aria-hidden="true"></i>
            <span>{{ sourceImport.selectedFileLabel() }}</span>
          </div>
          <span class="workbench-tag">
            {{
              sourceImport.isUploading()
                ? 'Uploading'
                : sourceImport.activeDocument()?.status ?? 'Waiting'
            }}
          </span>
        </div>

        @if (sourceImport.uploadItems().length > 0) {
          <div class="grid gap-2" aria-label="Selected source file upload status">
            @for (item of sourceImport.uploadItems(); track item.id) {
              <div
                class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-surface-200 bg-surface-0 p-3"
              >
                <div class="min-w-0 flex-1">
                  <p class="m-0 truncate text-sm font-semibold text-color">
                    {{ item.file.name }}
                  </p>
                  <p class="m-0 mt-1 text-xs font-semibold text-muted-color">
                    {{ formatFileSize(item.file) }}
                    @if (item.document) {
                      / {{ item.document.chunks_count }} chunks
                    }
                    @if (item.error) {
                      / {{ item.error }}
                    }
                  </p>
                </div>
                <p-tag
                  [value]="uploadStatusLabel(item.status)"
                  [severity]="uploadStatusSeverity(item.status)"
                  [rounded]="true"
                />
                @if (sourceImport.canCancelUploadItem(item)) {
                  <button
                    class="workbench-secondary-button"
                    type="button"
                    [disabled]="item.status === 'cancel_requested'"
                    (click)="sourceImport.cancelUploadItem(item.id)"
                  >
                    <i class="pi pi-times" aria-hidden="true"></i>
                    <span>
                      {{ item.status === 'cancel_requested' ? 'Canceling' : 'Cancel' }}
                    </span>
                  </button>
                }
              </div>
            }
          </div>
        }

        <div class="flex flex-wrap items-end gap-3">
          <label class="workbench-field min-w-32 flex-1">
            <span>Language</span>
            <select
              [ngModel]="sourceImport.languageHint()"
              (ngModelChange)="sourceImport.setLanguageHint($event)"
            >
              @for (language of sourceImport.languageHints; track language) {
                <option [value]="language">{{ language }}</option>
              }
            </select>
          </label>
          <label class="workbench-field min-w-32 flex-1">
            <span>Batch size</span>
            <select
              [ngModel]="sourceImport.uploadBatchSize()"
              [disabled]="isUploadBusy()"
              (ngModelChange)="sourceImport.setUploadBatchSize($event)"
            >
              @for (size of sourceImport.uploadBatchSizes; track size) {
                <option [value]="size">{{ size }}</option>
              }
            </select>
          </label>
          <button
            class="workbench-action-button min-w-32 flex-none"
            type="button"
            [disabled]="operations.isBusyFor('upload') || !sourceImport.canUpload()"
            (click)="uploadDocument()"
          >
            <i
              [class]="operations.isBusyFor('upload') ? 'pi pi-spin pi-spinner' : 'pi pi-upload'"
              aria-hidden="true"
            ></i>
            <span>Upload files</span>
          </button>
        </div>

        @if (sourceImport.documents().length > 0) {
          <label class="workbench-field">
            <span>Project document library</span>
            <select
              [ngModel]="sourceImport.activeDocumentSelectValue()"
              (ngModelChange)="selectDocument($event)"
            >
              @for (document of sourceImport.documents(); track document.id) {
                <option [value]="document.id">
                  {{ document.filename }} - {{ document.status }} -
                  {{ document.chunks_count }} chunks
                </option>
              }
            </select>
          </label>
        }

        @if (sourceImport.activeDocument(); as document) {
          <section
            class="grid gap-3"
            aria-live="polite"
          >
            <div class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-surface-200 bg-surface-50 p-3">
              <div class="min-w-0 flex-1">
                <p class="m-0 truncate text-sm font-semibold text-color">
                  {{ sourceImport.parseStageText() }}
                </p>
                <p class="m-0 mt-1 text-xs font-semibold text-muted-color">
                  {{ sourceImport.progressLabel() }} / {{ document.chunks_count }}
                  chunks / {{ sourceImport.elapsedTime() }}
                </p>
              </div>
              <p-tag
                [value]="document.status"
                [severity]="document.status === 'processing' ? 'info' : document.status === 'ready' ? 'success' : 'warn'"
                [rounded]="true"
              />
              @if (document.status === 'processing' || document.status === 'cancel_requested') {
                <button
                  class="workbench-secondary-button"
                  type="button"
                  [disabled]="
                    document.status === 'cancel_requested' ||
                    operations.isBusyFor('document-cancel')
                  "
                  (click)="sourceImport.cancelActiveDocumentProcessing()"
                >
                  <i class="pi pi-times" aria-hidden="true"></i>
                  <span>
                    {{ document.status === 'cancel_requested' ? 'Canceling' : 'Cancel parsing' }}
                  </span>
                </button>
              } @else if (
                document.status === 'canceled' ||
                document.status === 'ocr_failed' ||
                document.status === 'no_text_detected' ||
                document.status === 'exam_failed'
              ) {
                <button
                  class="workbench-secondary-button"
                  type="button"
                  [disabled]="operations.isBusyFor('document-retry')"
                  (click)="sourceImport.retryActiveDocumentProcessing()"
                >
                  <i class="pi pi-refresh" aria-hidden="true"></i>
                  <span>Retry parsing</span>
                </button>
              }
            </div>
            <p-progressbar
              [value]="sourceImport.progressPercent()"
              [showValue]="false"
            />
            @if (sourceImport.pollingError(); as pollingError) {
              <div
                class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 p-3"
                role="alert"
              >
                <span class="text-sm font-semibold text-red-900">
                  {{ pollingError }}
                </span>
                <button
                  class="workbench-secondary-button"
                  type="button"
                  (click)="sourceImport.retryDocumentPolling()"
                >
                  <i class="pi pi-refresh" aria-hidden="true"></i>
                  <span>Retry progress</span>
                </button>
              </div>
            }
          </section>

          <dl class="workbench-metrics">
            <div class="workbench-metric">
              <dt>File Size</dt>
              <dd>{{ formatFileSize(activeDocumentFile()) }}</dd>
            </div>
            <div class="workbench-metric">
              <dt>Pages</dt>
              <dd>{{ document.page_count }}</dd>
            </div>
            <div class="workbench-metric">
              <dt>Text Chunks</dt>
              <dd>{{ document.chunks_count }}</dd>
            </div>
            <div class="workbench-metric">
              <dt>Mock Items</dt>
              <dd>
                {{ document.exam_item_count }}
              </dd>
            </div>
            <div class="workbench-metric">
              <dt>Processed</dt>
              <dd>
                {{ document.processed_page_count }}
              </dd>
            </div>
            <div class="workbench-metric">
              <dt>Language</dt>
              <dd>
                {{ document.language_hint }}
              </dd>
            </div>
            <div class="workbench-metric">
              <dt>Status</dt>
              <dd>{{ document.status }}</dd>
            </div>
            <div class="workbench-metric">
              <dt>Extraction</dt>
              <dd>{{ document.extraction_method }}</dd>
            </div>
            <div class="workbench-metric">
              <dt>OCR Device</dt>
              <dd>
                {{ document.ocr_device || 'none' }}
              </dd>
            </div>
            @for (metric of sourceImport.parsingMetrics(document); track metric.label) {
              <div class="workbench-metric">
                <dt>{{ metric.label }}</dt>
                <dd>{{ metric.value }}</dd>
              </div>
            }
            @if (document.ocr_fallback_reason) {
              <div
                class="rounded-md border border-amber-200 bg-amber-50 p-3 xl:col-span-2"
              >
                <dt class="text-xs font-bold uppercase text-amber-700">
                  OCR fallback
                </dt>
                <dd class="m-0 mt-1 text-sm font-semibold text-amber-900">
                  {{ document.ocr_fallback_reason }}
                </dd>
              </div>
            }
          </dl>

          @if (sourceImport.previewChunks().length > 0) {
            <section
              class="workbench-preview"
              aria-labelledby="extracted-text-heading"
            >
              <div class="workbench-preview-header">
                <h3
                  id="extracted-text-heading"
                >
                  Extracted Text Preview
                </h3>
                <i class="pi pi-search" aria-hidden="true"></i>
              </div>
              <div class="workbench-preview-list">
                @for (chunk of sourceImport.previewChunks(); track chunk.id) {
                  <article class="workbench-preview-chunk">
                    <strong>
                      Page {{ chunk.page_number }} - Chunk {{ chunk.chunk_index + 1 }}
                    </strong>
                    <p class="whitespace-pre-wrap">
                      {{ chunk.text }}
                    </p>
                  </article>
                }
                @if (sourceImport.hiddenChunkCount() > 0) {
                  <div
                    class="flex flex-wrap items-center justify-between gap-2 p-3"
                  >
                    <p class="m-0 text-sm text-muted-color">
                      {{ sourceImport.hiddenChunkCount() }} more chunks available.
                    </p>
                    <button
                      class="workbench-secondary-button"
                      type="button"
                      (click)="sourceImport.showMoreChunks()"
                    >
                      <i class="pi pi-chevron-down" aria-hidden="true"></i>
                      <span>Show more</span>
                    </button>
                  </div>
                }
              </div>
            </section>
          } @else if (sourceImport.isParsing()) {
            <p
              class="m-0 rounded-md border border-dashed border-surface-300 bg-surface-0 p-3 text-sm text-muted-color"
            >
              Waiting for the first extracted chunk.
            </p>
          }
        } @else {
          <p class="m-0 rounded-md border border-dashed border-surface-300 bg-surface-0 p-3 text-sm text-muted-color">
            Choose one or more PDF, PNG, JPEG, or WebP files and upload them to
            start extraction.
          </p>
        }
      </div>
    </section>
  `,
})
export class SourceImportPanelComponent {
  protected readonly drafts = inject(DraftReviewStore);
  protected readonly operations = inject(OperationStore);
  protected readonly projects = inject(ProjectStore);
  protected readonly sourceImport = inject(SourceImportStore);

  protected chooseFiles(event: Event): void {
    if (this.isUploadBusy()) {
      return;
    }
    const input = event.target as HTMLInputElement;
    this.sourceImport.chooseFiles(Array.from(input.files ?? []));
  }

  protected async uploadDocument(): Promise<void> {
    const documents = await this.sourceImport.uploadDocuments();
    const project = this.projects.selectedProject();
    if (documents.length > 0 && project !== null) {
      await this.drafts.load(project.id);
    }
  }

  protected async selectDocument(documentId: string): Promise<void> {
    await this.sourceImport.selectDocument(documentId);
    const project = this.projects.selectedProject();
    if (project !== null) {
      await this.drafts.load(project.id);
    }
  }

  protected formatFileSize(file: File | null): string {
    if (file === null) {
      return '-';
    }
    const megaBytes = file.size / (1024 * 1024);
    if (megaBytes >= 1) {
      return `${megaBytes.toFixed(1)} MB`;
    }
    return `${Math.max(1, Math.round(file.size / 1024))} KB`;
  }

  protected activeDocumentFile(): File | null {
    const document = this.sourceImport.activeDocument();
    if (document === null) {
      return this.sourceImport.selectedFile();
    }

    return (
      this.sourceImport.uploadItems().find((item) => item.document?.id === document.id)
        ?.file ?? null
    );
  }

  protected isUploadBusy(): boolean {
    return this.sourceImport.isUploading() || this.operations.isBusyFor('upload');
  }

  protected uploadStatusLabel(status: string): string {
    if (status === 'queued') {
      return 'Queued';
    }
    if (status === 'uploading') {
      return 'Uploading';
    }
    if (status === 'uploaded') {
      return 'Uploaded';
    }
    if (status === 'cancel_requested') {
      return 'Canceling';
    }
    if (status === 'canceled') {
      return 'Canceled';
    }
    return 'Failed';
  }

  protected uploadStatusSeverity(status: string): 'success' | 'info' | 'warn' | 'danger' {
    if (status === 'uploaded') {
      return 'success';
    }
    if (status === 'uploading') {
      return 'info';
    }
    if (status === 'failed') {
      return 'danger';
    }
    if (status === 'canceled' || status === 'cancel_requested') {
      return 'warn';
    }
    return 'warn';
  }
}
