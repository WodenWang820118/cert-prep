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
            <i class="pi pi-file-pdf"></i>
          </span>
          <h2 id="source-heading">Step 01: Source PDF</h2>
        </div>
        <label class="workbench-secondary-button" for="sourcePdfFile">
          <i class="pi pi-upload" aria-hidden="true"></i>
          <span>Choose PDF</span>
        </label>
      </header>

      <div class="workbench-panel-body">
        <input
          id="sourcePdfFile"
          class="sr-only"
          type="file"
          accept="application/pdf"
          aria-label="PDF file"
          (change)="chooseFile($event)"
        />

        <div class="workbench-file-row">
          <div class="workbench-file-name">
            <i class="pi pi-file" aria-hidden="true"></i>
            <span>
              {{
                sourceImport.selectedFile()?.name ??
                  sourceImport.activeDocument()?.filename ??
                  'No PDF selected'
              }}
            </span>
          </div>
          <span class="workbench-tag">
            {{ sourceImport.activeDocument()?.status ?? 'Waiting' }}
          </span>
        </div>

        <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_10rem_auto] md:items-end">
          <label class="workbench-field">
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
          <button
            class="workbench-action-button"
            type="button"
            [disabled]="operations.isBusyFor('upload') || !sourceImport.canUpload()"
            (click)="uploadDocument()"
          >
            <i
              [class]="operations.isBusyFor('upload') ? 'pi pi-spin pi-spinner' : 'pi pi-upload'"
              aria-hidden="true"
            ></i>
            <span>Upload PDF</span>
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
              <div class="min-w-0">
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
            </div>
            <p-progressbar
              [value]="sourceImport.progressPercent()"
              [showValue]="false"
            />
          </section>

          <dl class="workbench-metrics">
            <div class="workbench-metric">
              <dt>File Size</dt>
              <dd>{{ formatFileSize(sourceImport.selectedFile()) }}</dd>
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
            Choose a PDF and upload it to start extraction.
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

  protected chooseFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.sourceImport.chooseFile(input.files?.item(0) ?? null);
  }

  protected async uploadDocument(): Promise<void> {
    const document = await this.sourceImport.uploadDocument();
    const project = this.projects.selectedProject();
    if (document !== null && project !== null) {
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
}
