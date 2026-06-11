import { Component, inject } from '@angular/core';
import { Button } from 'primeng/button';
import { Dialog } from 'primeng/dialog';
import { ProgressBar } from 'primeng/progressbar';
import { Tag } from 'primeng/tag';
import { HealthStore, ModelDownloadView } from '../stores/health.store';
import { OperationStore } from '../stores/operation.store';

@Component({
  selector: 'app-model-health',
  imports: [Button, Dialog, ProgressBar, Tag],
  template: `
    <div
      class="grid gap-3 rounded-lg border border-surface-200 bg-surface-0 p-3 shadow-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
    >
      <div class="grid min-w-0 gap-3 md:grid-cols-2">
        @if (health.llmHealth(); as modelHealth) {
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <p-tag
                [severity]="modelHealth.available ? 'success' : 'danger'"
                [value]="modelHealth.available ? 'Online' : 'Offline'"
                [rounded]="true"
              />
              <strong class="truncate text-sm text-color">
                {{ modelHealth.provider }} / {{ modelHealth.model }}
              </strong>
            </div>
            <p class="m-0 mt-1 text-sm leading-5 text-muted-color">
              {{ modelHealth.detail }}
            </p>
            @if (health.isModelMissing()) {
              <p
                class="m-0 mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs font-semibold text-amber-900"
              >
                {{ modelHealth.model }} is missing locally.
              </p>
            }
          </div>
        } @else {
          <div>
            <div class="flex items-center gap-2">
              <p-tag severity="danger" value="Offline" [rounded]="true" />
              <strong class="text-sm text-color">Model health</strong>
            </div>
            <p class="m-0 mt-1 text-sm text-muted-color">Unavailable</p>
          </div>
        }
        @if (health.ocrHealth(); as ocrHealth) {
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <p-tag
                [severity]="ocrHealth.available ? 'success' : 'danger'"
                [value]="ocrHealth.available ? 'OCR ready' : 'OCR offline'"
                [rounded]="true"
              />
              <strong class="truncate text-sm text-color">
                {{ ocrHealth.provider }} / {{ ocrHealth.selected_device || 'none' }}
              </strong>
            </div>
            <p class="m-0 mt-1 text-sm leading-5 text-muted-color">
              {{ ocrHealth.fallback_reason || ocrHealth.detail }}
            </p>
          </div>
        } @else {
          <div>
            <div class="flex items-center gap-2">
              <p-tag severity="danger" value="OCR offline" [rounded]="true" />
              <strong class="text-sm text-color">OCR health</strong>
            </div>
            <p class="m-0 mt-1 text-sm text-muted-color">Unavailable</p>
          </div>
        }
      </div>
      <div class="grid gap-2 sm:justify-items-end">
        @if (health.canDownloadModel()) {
          <p-button
            [label]="health.modelDownloadActionLabel()"
            icon="pi pi-download"
            severity="warn"
            [outlined]="true"
            [disabled]="operations.isBusy()"
            (onClick)="health.openModelDownloadConsent()"
          />
        }
        @if (health.modelDownload(); as download) {
          <p-button
            label="Refresh status"
            icon="pi pi-refresh"
            severity="secondary"
            [outlined]="true"
            [disabled]="health.modelDownloadStarting()"
            (onClick)="health.refreshModelDownload()"
          />
        }
        <p-button
          label="Refresh"
          icon="pi pi-refresh"
          severity="secondary"
          [outlined]="true"
          [disabled]="operations.isBusy()"
          (onClick)="health.refresh()"
        />
      </div>

      @if (health.modelDownload(); as download) {
        <div class="sm:col-span-2" aria-live="polite">
          <div
            class="grid gap-2 rounded-md border border-surface-200 bg-surface-50 p-3"
          >
            <div class="flex flex-wrap items-center gap-2">
              <p-tag
                [severity]="downloadSeverity(download)"
                [value]="download.status"
                [rounded]="true"
              />
              <strong class="text-sm text-color">{{ download.model }}</strong>
            </div>
            <p class="m-0 text-sm text-muted-color">{{ download.message }}</p>
            @if (download.progress !== null) {
              <p-progressbar [value]="download.progress" />
            }
          </div>
        </div>
      }
    </div>

    <p-dialog
      header="Download Ollama model"
      [visible]="health.modelDownloadConsentVisible()"
      [modal]="true"
      [draggable]="false"
      [resizable]="false"
      [closable]="!health.modelDownloadStarting()"
      [closeOnEscape]="!health.modelDownloadStarting()"
      [dismissableMask]="false"
      [style]="{ width: 'min(92vw, 32rem)' }"
      (visibleChange)="health.setModelDownloadConsentVisible($event)"
    >
      <div class="grid gap-3">
        <p class="m-0 text-sm leading-6 text-color">
          Download {{ health.llmHealth()?.model }} with Ollama?
        </p>
        <p class="m-0 text-sm leading-6 text-muted-color">
          This starts a background download and can take several minutes on a
          slower connection.
        </p>
        <div class="flex flex-wrap justify-end gap-2 pt-2">
          <p-button
            label="Cancel"
            severity="secondary"
            [outlined]="true"
            [disabled]="health.modelDownloadStarting()"
            (onClick)="health.cancelModelDownloadConsent()"
          />
          <p-button
            label="Download"
            icon="pi pi-download"
            severity="warn"
            [loading]="health.modelDownloadStarting()"
            (onClick)="health.confirmModelDownload()"
          />
        </div>
      </div>
    </p-dialog>
  `,
})
export class ModelHealthComponent {
  protected readonly health = inject(HealthStore);
  protected readonly operations = inject(OperationStore);

  protected downloadSeverity(
    download: ModelDownloadView,
  ): 'success' | 'danger' | 'info' | 'warn' {
    if (download.phase === 'succeeded') {
      return 'success';
    }

    if (download.phase === 'failed') {
      return 'danger';
    }

    return download.phase === 'starting' ? 'info' : 'warn';
  }
}
