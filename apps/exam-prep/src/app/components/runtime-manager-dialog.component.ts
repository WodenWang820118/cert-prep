import { Component, EventEmitter, inject, Input, Output } from '@angular/core';
import { Button } from 'primeng/button';
import { Dialog } from 'primeng/dialog';
import { ProgressBar } from 'primeng/progressbar';
import { DesktopRuntimeStore } from '../stores/desktop-runtime.store';
import { HealthStore } from '../stores/health.store';
import { OperationStore } from '../stores/operation.store';
import type { ModelHealthViewModel } from './model-health.view-model';
import { RuntimeStatusRowComponent } from './runtime-status-row.component';

@Component({
  selector: 'app-runtime-manager-dialog',
  imports: [Button, Dialog, ProgressBar, RuntimeStatusRowComponent],
  template: `
    <p-dialog
      header="Manage runtime"
      [visible]="visible"
      [modal]="true"
      [draggable]="false"
      [resizable]="false"
      [style]="{ width: 'min(96vw, 56rem)' }"
      (visibleChange)="visibleChange.emit($event)"
    >
      <div class="grid gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <strong class="text-sm text-color">Runtime details</strong>
          <p-button
            label="Refresh"
            icon="pi pi-refresh"
            severity="secondary"
            [outlined]="true"
            [disabled]="operations.isBusyFor(['health', 'startup'])"
            (onClick)="refreshAll.emit()"
          />
        </div>

        <app-runtime-status-row [section]="viewModel.python">
          <ng-container actions>
            @if (desktopRuntime.canInstallPythonRuntime()) {
              <p-button
                label="Install runtime"
                icon="pi pi-download"
                severity="warn"
                [outlined]="true"
                [disabled]="desktopRuntime.installStarting()"
                (onClick)="desktopRuntime.openInstallConsent()"
              />
            }
            @if (desktopRuntime.installation()) {
              <p-button
                label="Refresh runtime"
                icon="pi pi-refresh"
                severity="secondary"
                [outlined]="true"
                [disabled]="desktopRuntime.installStarting()"
                (onClick)="desktopRuntime.refreshInstallation()"
              />
            }
          </ng-container>
          @if (desktopRuntime.installProgress(); as progress) {
            <p-progressbar progress class="sm:col-span-2" [value]="progress" />
          }
        </app-runtime-status-row>

        <app-runtime-status-row [section]="viewModel.ollama">
          <ng-container actions>
            @if (desktopRuntime.isBackendReady() && health.canInstallOllama()) {
              <p-button
                label="Install Ollama"
                icon="pi pi-download"
                severity="warn"
                [outlined]="true"
                [disabled]="health.runtimeInstallStarting()"
                (onClick)="health.openOllamaInstallConsent()"
              />
            }
          </ng-container>
        </app-runtime-status-row>

        <app-runtime-status-row [section]="viewModel.model">
          <ng-container actions>
            @if (desktopRuntime.isBackendReady() && health.canDownloadModel()) {
              <p-button
                [label]="modelDownloadActionLabel"
                icon="pi pi-download"
                severity="warn"
                [outlined]="true"
                [disabled]="health.modelDownloadStarting()"
                (onClick)="health.openModelDownloadConsent()"
              />
            }
            @if (health.modelDownload()) {
              <p-button
                label="Refresh model"
                icon="pi pi-refresh"
                severity="secondary"
                [outlined]="true"
                [disabled]="health.modelDownloadStarting()"
                (onClick)="health.refreshModelDownload()"
              />
            }
          </ng-container>
          @if (health.modelDownload(); as download) {
            <div progress class="grid gap-2 sm:col-span-2" aria-live="polite">
              <p class="m-0 text-sm text-muted-color">{{ download.message }}</p>
              @if (download.progress !== null) {
                <p-progressbar [value]="download.progress" />
              }
            </div>
          }
        </app-runtime-status-row>

        <app-runtime-status-row [section]="viewModel.ocr">
          <ng-container actions>
            @if (
              desktopRuntime.isBackendReady() && health.canInstallOcrRuntime()
            ) {
              <p-button
                label="Install OCR"
                icon="pi pi-download"
                severity="warn"
                [outlined]="true"
                [disabled]="health.runtimeInstallStarting()"
                (onClick)="health.openOcrRuntimeInstallConsent()"
              />
            }
            @if (health.runtimeInstall()) {
              <p-button
                label="Refresh install"
                icon="pi pi-refresh"
                severity="secondary"
                [outlined]="true"
                [disabled]="health.runtimeInstallStarting()"
                (onClick)="health.refreshRuntimeInstallation()"
              />
            }
          </ng-container>
          @if (health.runtimeInstall(); as install) {
            <div progress class="grid gap-2 sm:col-span-2" aria-live="polite">
              <p class="m-0 text-sm text-muted-color">{{ install.message }}</p>
              @if (install.progress !== null) {
                <p-progressbar [value]="install.progress" />
              }
            </div>
          }
        </app-runtime-status-row>
      </div>
    </p-dialog>
  `,
})
export class RuntimeManagerDialogComponent {
  protected readonly desktopRuntime = inject(DesktopRuntimeStore);
  protected readonly health = inject(HealthStore);
  protected readonly operations = inject(OperationStore);
  @Input({ required: true }) viewModel!: ModelHealthViewModel;
  @Input() visible = false;
  @Input() modelDownloadActionLabel = 'Download model';
  @Output() readonly visibleChange = new EventEmitter<boolean>();
  @Output() readonly refreshAll = new EventEmitter<void>();
}
