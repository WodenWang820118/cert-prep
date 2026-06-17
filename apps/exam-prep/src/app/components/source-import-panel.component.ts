import { Component, inject } from '@angular/core';
import { Button } from 'primeng/button';
import { Card } from 'primeng/card';
import { Tag } from 'primeng/tag';
import { OperationStore } from '../stores/operation.store';
import { ProjectStore } from '../stores/project.store';
import { DraftReviewStore } from '../stores/draft-review.store';
import { SourceImportStore } from '../stores/source-import.store';

@Component({
  selector: 'app-source-import-panel',
  imports: [Button, Card, Tag],
  template: `
    <p-card styleClass="exam-card">
      <div class="grid gap-4">
        <div class="grid grid-cols-[2.25rem_minmax(0,1fr)] items-start gap-3">
          <span
            class="grid h-9 w-9 place-items-center rounded-md border border-primary-200 bg-primary-50 text-sm font-bold text-primary"
          >
            01
          </span>
          <div class="min-w-0">
            <h2 id="source-heading" class="m-0 text-base font-bold text-color">
              Source PDF
            </h2>
            <p class="m-0 mt-1 truncate text-sm text-muted-color">
              {{ projects.selectedProject()?.name }}
            </p>
          </div>
        </div>

        <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <label class="grid gap-1.5 text-sm font-semibold text-muted-color">
            <span>PDF file</span>
            <input
              class="w-full rounded-md border border-surface-300 bg-surface-0 p-2 text-sm text-color file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-2 file:text-sm file:font-semibold file:text-primary-contrast"
              type="file"
              accept="application/pdf"
              (change)="chooseFile($event)"
            />
          </label>
          <p-button
            label="Upload PDF"
            icon="pi pi-upload"
            type="button"
            [disabled]="operations.isBusy() || !sourceImport.canUpload()"
            (onClick)="uploadDocument()"
          />
        </div>

        @if (sourceImport.uploadedDocument(); as document) {
          <dl class="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <div class="rounded-md border border-surface-200 bg-surface-50 p-3">
              <dt class="text-xs font-bold uppercase text-muted-color">File</dt>
              <dd class="m-0 mt-1 truncate text-sm font-semibold text-color">
                {{ document.filename }}
              </dd>
            </div>
            <div class="rounded-md border border-surface-200 bg-surface-50 p-3">
              <dt class="text-xs font-bold uppercase text-muted-color">Pages</dt>
              <dd class="m-0 mt-1 text-sm font-semibold text-color">
                {{ document.page_count }}
              </dd>
            </div>
            <div class="rounded-md border border-surface-200 bg-surface-50 p-3">
              <dt class="text-xs font-bold uppercase text-muted-color">
                Text chunks
              </dt>
              <dd class="m-0 mt-1 text-sm font-semibold text-color">
                {{ document.chunks_count }}
              </dd>
            </div>
            <div class="rounded-md border border-surface-200 bg-surface-50 p-3">
              <dt class="text-xs font-bold uppercase text-muted-color">
                Mock items
              </dt>
              <dd class="m-0 mt-1 text-sm font-semibold text-color">
                {{ document.exam_item_count }}
              </dd>
            </div>
            <div class="rounded-md border border-surface-200 bg-surface-50 p-3">
              <dt class="text-xs font-bold uppercase text-muted-color">
                Processed
              </dt>
              <dd class="m-0 mt-1 text-sm font-semibold text-color">
                {{ document.processed_page_count }}
              </dd>
            </div>
            <div class="rounded-md border border-surface-200 bg-surface-50 p-3">
              <dt class="text-xs font-bold uppercase text-muted-color">Status</dt>
              <dd class="m-0 mt-1">
                <p-tag [value]="document.status" [rounded]="true" />
              </dd>
            </div>
            <div class="rounded-md border border-surface-200 bg-surface-50 p-3">
              <dt class="text-xs font-bold uppercase text-muted-color">
                Extraction
              </dt>
              <dd class="m-0 mt-1">
                <p-tag
                  [value]="document.extraction_method"
                  severity="secondary"
                  [rounded]="true"
                />
              </dd>
            </div>
            <div class="rounded-md border border-surface-200 bg-surface-50 p-3">
              <dt class="text-xs font-bold uppercase text-muted-color">
                OCR device
              </dt>
              <dd class="m-0 mt-1 text-sm font-semibold text-color">
                {{ document.ocr_device || 'none' }}
              </dd>
            </div>
            <div class="rounded-md border border-surface-200 bg-surface-50 p-3">
              <dt class="text-xs font-bold uppercase text-muted-color">
                OCR time
              </dt>
              <dd class="m-0 mt-1 text-sm font-semibold text-color">
                {{ document.ocr_duration_ms }} ms
              </dd>
            </div>
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
              class="grid gap-3 rounded-md border border-surface-200 bg-surface-0 p-3"
              aria-labelledby="extracted-text-heading"
            >
              <div class="flex flex-wrap items-center justify-between gap-2">
                <h3
                  id="extracted-text-heading"
                  class="m-0 text-sm font-bold uppercase text-muted-color"
                >
                  Extracted text
                </h3>
                <p-tag
                  [value]="sourceImport.chunks().length + ' chunks'"
                  severity="secondary"
                  [rounded]="true"
                />
              </div>
              <div class="grid max-h-96 gap-2 overflow-auto pr-1">
                @for (chunk of sourceImport.previewChunks(); track chunk.id) {
                  <article class="grid gap-1 rounded-md bg-surface-50 p-3">
                    <div class="flex flex-wrap items-center gap-2">
                      <p-tag
                        [value]="'Page ' + chunk.page_number"
                        severity="secondary"
                        [rounded]="true"
                      />
                      <span class="text-xs font-semibold text-muted-color">
                        {{ chunk.extraction_method }}
                      </span>
                    </div>
                    <p class="m-0 whitespace-pre-wrap text-sm leading-6 text-color">
                      {{ chunk.text }}
                    </p>
                  </article>
                }
                @if (sourceImport.hiddenChunkCount() > 0) {
                  <p
                    class="m-0 rounded-md border border-dashed border-surface-300 p-3 text-sm text-muted-color"
                  >
                    {{ sourceImport.hiddenChunkCount() }} more chunks available.
                  </p>
                }
              </div>
            </section>
          }
        }
      </div>
    </p-card>
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
}
