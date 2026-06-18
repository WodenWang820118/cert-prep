import { Component, effect, inject, signal } from '@angular/core';
import { Button } from 'primeng/button';
import { Dialog } from 'primeng/dialog';
import { ProgressBar } from 'primeng/progressbar';
import { Tag } from 'primeng/tag';
import { DesktopRuntimeStore } from '../stores/desktop-runtime.store';
import { HealthStore } from '../stores/health.store';
import { OperationStore } from '../stores/operation.store';
import { WorkspaceFacade } from '../stores/workspace.facade';

@Component({
  selector: 'app-model-health',
  imports: [Button, Dialog, ProgressBar, Tag],
  template: `
    <div
      class="flex flex-wrap items-center justify-end gap-2 rounded-lg border border-surface-200 bg-surface-0 p-2 shadow-sm"
    >
      <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <p-tag
          [severity]="pythonSeverity()"
          [value]="pythonChipLabel()"
          [rounded]="true"
        />
        <p-tag
          [severity]="ollamaSeverity()"
          [value]="ollamaChipLabel()"
          [rounded]="true"
        />
        <p-tag
          [severity]="modelSeverity()"
          [value]="modelChipLabel()"
          [rounded]="true"
        />
        <p-tag
          [severity]="ocrSeverity()"
          [value]="ocrChipLabel()"
          [rounded]="true"
        />
      </div>
      <p-button
        label="Manage runtime"
        icon="pi pi-sliders-h"
        severity="secondary"
        [outlined]="true"
        (onClick)="runtimeDialogVisible.set(true)"
      />
    </div>

    <p-dialog
      header="Manage runtime"
      [visible]="runtimeDialogVisible()"
      [modal]="true"
      [draggable]="false"
      [resizable]="false"
      [style]="{ width: 'min(96vw, 56rem)' }"
      (visibleChange)="runtimeDialogVisible.set($event)"
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
            (onClick)="refreshAll()"
          />
        </div>

        <div
          class="grid gap-2 rounded-md border border-surface-200 bg-surface-50 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
        >
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <p-tag
                [severity]="pythonSeverity()"
                [value]="
                  desktopRuntime.status().running
                    ? 'Ready'
                    : desktopRuntime.status().status
                "
                [rounded]="true"
              />
              <strong class="truncate text-sm text-color">
                Python backend
              </strong>
            </div>
            <p class="m-0 mt-1 text-sm leading-5 text-muted-color">
              {{ pythonDetail() }}
            </p>
          </div>
          <div class="flex flex-wrap gap-2 sm:justify-end">
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
            @if (desktopRuntime.installation(); as install) {
              <p-button
                label="Refresh runtime"
                icon="pi pi-refresh"
                severity="secondary"
                [outlined]="true"
                [disabled]="desktopRuntime.installStarting()"
                (onClick)="desktopRuntime.refreshInstallation()"
              />
            }
          </div>
          @if (desktopRuntime.installProgress(); as progress) {
            <p-progressbar class="sm:col-span-2" [value]="progress" />
          }
        </div>

        <div
          class="grid gap-2 rounded-md border border-surface-200 bg-surface-50 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
        >
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <p-tag
                [severity]="ollamaSeverity()"
                [value]="ollamaStatusLabel()"
                [rounded]="true"
              />
              <strong class="truncate text-sm text-color">Ollama</strong>
            </div>
            <p class="m-0 mt-1 text-sm leading-5 text-muted-color">
              {{ ollamaDetail() }}
            </p>
          </div>
          <div class="flex flex-wrap gap-2 sm:justify-end">
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
          </div>
        </div>

        <div
          class="grid gap-2 rounded-md border border-surface-200 bg-surface-50 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
        >
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <p-tag
                [severity]="modelSeverity()"
                [value]="modelStatusLabel()"
                [rounded]="true"
              />
              <strong class="truncate text-sm text-color">
                Reasoning model
              </strong>
            </div>
            <p class="m-0 mt-1 text-sm leading-5 text-muted-color">
              {{ modelDetail() }}
            </p>
          </div>
          <div class="flex flex-wrap gap-2 sm:justify-end">
            @if (desktopRuntime.isBackendReady() && health.canDownloadModel()) {
              <p-button
                [label]="health.modelDownloadActionLabel()"
                icon="pi pi-download"
                severity="warn"
                [outlined]="true"
                [disabled]="health.modelDownloadStarting()"
                (onClick)="health.openModelDownloadConsent()"
              />
            }
            @if (health.modelDownload(); as download) {
              <p-button
                label="Refresh model"
                icon="pi pi-refresh"
                severity="secondary"
                [outlined]="true"
                [disabled]="health.modelDownloadStarting()"
                (onClick)="health.refreshModelDownload()"
              />
            }
          </div>
          @if (health.modelDownload(); as download) {
            <div class="grid gap-2 sm:col-span-2" aria-live="polite">
              <p class="m-0 text-sm text-muted-color">{{ download.message }}</p>
              @if (download.progress !== null) {
                <p-progressbar [value]="download.progress" />
              }
            </div>
          }
        </div>

        <div
          class="grid gap-2 rounded-md border border-surface-200 bg-surface-50 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
        >
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <p-tag
                [severity]="ocrSeverity()"
                [value]="ocrStatusLabel()"
                [rounded]="true"
              />
              <strong class="truncate text-sm text-color">PaddleOCR</strong>
            </div>
            <p class="m-0 mt-1 text-sm leading-5 text-muted-color">
              {{ ocrDetail() }}
            </p>
          </div>
          <div class="flex flex-wrap gap-2 sm:justify-end">
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
            @if (health.runtimeInstall(); as install) {
              <p-button
                label="Refresh install"
                icon="pi pi-refresh"
                severity="secondary"
                [outlined]="true"
                [disabled]="health.runtimeInstallStarting()"
                (onClick)="health.refreshRuntimeInstallation()"
              />
            }
          </div>
          @if (health.runtimeInstall(); as install) {
            <div class="grid gap-2 sm:col-span-2" aria-live="polite">
              <p class="m-0 text-sm text-muted-color">{{ install.message }}</p>
              @if (install.progress !== null) {
                <p-progressbar [value]="install.progress" />
              }
            </div>
          }
        </div>
      </div>
    </p-dialog>

    <p-dialog
      header="Install Python backend runtime"
      [visible]="desktopRuntime.installConsentVisible()"
      [modal]="true"
      [draggable]="false"
      [resizable]="false"
      [closable]="!desktopRuntime.installStarting()"
      [closeOnEscape]="!desktopRuntime.installStarting()"
      [dismissableMask]="false"
      [style]="{ width: 'min(92vw, 34rem)' }"
      (visibleChange)="desktopRuntime.setInstallConsentVisible($event)"
    >
      <div class="grid gap-3">
        <p class="m-0 text-sm leading-6 text-color">
          Download the packaged Python backend runtime?
        </p>
        <p class="m-0 text-sm leading-6 text-muted-color">
          The app verifies the downloaded runtime before it is extracted under
          your user app data.
        </p>
        <div class="flex flex-wrap justify-end gap-2 pt-2">
          <p-button
            label="Cancel"
            severity="secondary"
            [outlined]="true"
            [disabled]="desktopRuntime.installStarting()"
            (onClick)="desktopRuntime.cancelInstallConsent()"
          />
          <p-button
            label="Install"
            icon="pi pi-download"
            severity="warn"
            [loading]="desktopRuntime.installStarting()"
            (onClick)="desktopRuntime.confirmPythonRuntimeInstallation()"
          />
        </div>
      </div>
    </p-dialog>

    <p-dialog
      header="Download reasoning model"
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
          Download {{ health.configuredModelName() }} with Ollama?
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

    <p-dialog
      [header]="'Install ' + health.runtimeInstallConsentLabel()"
      [visible]="health.runtimeInstallConsentVisible()"
      [modal]="true"
      [draggable]="false"
      [resizable]="false"
      [closable]="!health.runtimeInstallStarting()"
      [closeOnEscape]="!health.runtimeInstallStarting()"
      [dismissableMask]="false"
      [style]="{ width: 'min(92vw, 34rem)' }"
      (visibleChange)="health.setRuntimeInstallConsentVisible($event)"
    >
      <div class="grid gap-3">
        @if (health.runtimeInstallConsentKind() === 'paddle_ocr') {
          <p class="m-0 text-sm leading-6 text-color">
            Install the PaddleOCR runtime for image-only PDFs?
          </p>
          <p class="m-0 text-sm leading-6 text-muted-color">
            The runtime is downloaded from the release asset, verified, and
            extracted under your user app data.
          </p>
        } @else {
          <p class="m-0 text-sm leading-6 text-color">
            Install Ollama for local AI generation?
          </p>
          <p class="m-0 text-sm leading-6 text-muted-color">
            This starts the official Windows installer. Return here and refresh
            the status if Windows asks for confirmation.
          </p>
        }
        <div class="flex flex-wrap justify-end gap-2 pt-2">
          <p-button
            label="Cancel"
            severity="secondary"
            [outlined]="true"
            [disabled]="health.runtimeInstallStarting()"
            (onClick)="health.cancelRuntimeInstallConsent()"
          />
          <p-button
            label="Install"
            icon="pi pi-download"
            severity="warn"
            [loading]="health.runtimeInstallStarting()"
            (onClick)="health.confirmRuntimeInstallation()"
          />
        </div>
      </div>
    </p-dialog>
  `,
})
export class ModelHealthComponent {
  protected readonly desktopRuntime = inject(DesktopRuntimeStore);
  protected readonly health = inject(HealthStore);
  protected readonly operations = inject(OperationStore);
  protected readonly runtimeDialogVisible = signal(false);
  private readonly workspace = inject(WorkspaceFacade);
  private loadingBackendState = false;

  constructor() {
    effect(() => {
      if (
        this.desktopRuntime.isDesktop() &&
        this.desktopRuntime.isBackendReady() &&
        !this.workspace.hasLoadedBackendState() &&
        !this.loadingBackendState
      ) {
        this.loadingBackendState = true;
        queueMicrotask(async () => {
          await this.workspace.loadStartupState();
          this.loadingBackendState = false;
        });
      }
    });
  }

  protected async refreshAll(): Promise<void> {
    if (this.desktopRuntime.isBackendReady()) {
      await this.health.refresh();
      return;
    }
    await this.desktopRuntime.load();
  }

  protected pythonChipLabel(): string {
    const system = this.health.systemHealth();
    if (this.desktopRuntime.isBackendReady() && system !== null) {
      return `Python ${system.python_version}`;
    }

    return this.desktopRuntime.isPythonRuntimeMissing()
      ? 'Python missing'
      : `Python ${this.desktopRuntime.status().status}`;
  }

  protected ollamaChipLabel(): string {
    if (!this.desktopRuntime.isBackendReady()) {
      return 'Ollama waiting';
    }
    if (this.health.isOllamaMissing()) {
      return 'Ollama missing';
    }
    return this.health.llmHealth()?.provider ?? 'Ollama unknown';
  }

  protected modelChipLabel(): string {
    const model = this.health.configuredModelName();
    return this.health.isModelMissing()
      ? 'Reasoning model missing'
      : `Reasoning model: ${model}`;
  }

  protected ocrChipLabel(): string {
    if (!this.desktopRuntime.isBackendReady()) {
      return 'OCR waiting';
    }

    const health = this.health.ocrHealth();
    if (health === null) {
      return 'OCR unknown';
    }

    const device = health.selected_device ?? health.engine;
    return `${health.provider} / ${device}`;
  }

  protected pythonDetail(): string {
    const system = this.health.systemHealth();
    if (this.desktopRuntime.isBackendReady() && system !== null) {
      return `Python ${system.python_version} / ${system.runtime_mode}`;
    }
    const install = this.desktopRuntime.installation();
    return install?.detail ?? this.desktopRuntime.status().detail;
  }

  protected ollamaDetail(): string {
    if (!this.desktopRuntime.isBackendReady()) {
      return 'Waiting for Python backend runtime.';
    }
    const health = this.health.llmHealth();
    if (health === null) {
      return 'Ollama status unavailable.';
    }
    return this.health.isOllamaMissing()
      ? 'Ollama is not installed.'
      : health.detail;
  }

  protected modelDetail(): string {
    if (!this.desktopRuntime.isBackendReady()) {
      return 'Waiting for Python backend runtime.';
    }
    if (this.health.isOllamaMissing()) {
      return 'Install Ollama before downloading the reasoning model.';
    }
    const health = this.health.llmHealth();
    if (health === null) {
      return 'Model status unavailable.';
    }
    return this.health.isModelMissing()
      ? `${health.model} is missing locally.`
      : health.detail;
  }

  protected ocrDetail(): string {
    if (!this.desktopRuntime.isBackendReady()) {
      return 'Waiting for Python backend runtime.';
    }
    const health = this.health.ocrHealth();
    if (health === null) {
      return 'PaddleOCR status unavailable.';
    }
    return health.fallback_reason || health.detail;
  }

  protected ollamaStatusLabel(): string {
    if (!this.desktopRuntime.isBackendReady()) {
      return 'Waiting';
    }
    if (this.health.isOllamaMissing()) {
      return 'Missing';
    }
    return this.health.llmHealth() === null ? 'Unknown' : 'Ready';
  }

  protected modelStatusLabel(): string {
    if (
      !this.desktopRuntime.isBackendReady() ||
      this.health.isOllamaMissing()
    ) {
      return 'Waiting';
    }
    if (this.health.isModelMissing()) {
      return 'Missing';
    }
    return this.health.llmHealth()?.available ? 'Ready' : 'Offline';
  }

  protected ocrStatusLabel(): string {
    if (!this.desktopRuntime.isBackendReady()) {
      return 'Waiting';
    }
    if (this.health.isOcrRuntimeMissing()) {
      return 'Missing';
    }
    return this.health.ocrHealth()?.available ? 'Ready' : 'Offline';
  }

  protected pythonSeverity(): 'success' | 'danger' | 'info' | 'warn' {
    if (this.desktopRuntime.isBackendReady()) {
      return 'success';
    }
    if (this.desktopRuntime.isInstallActive()) {
      return 'warn';
    }
    return this.desktopRuntime.isPythonRuntimeMissing() ? 'danger' : 'info';
  }

  protected ollamaSeverity(): 'success' | 'danger' | 'info' | 'warn' {
    if (!this.desktopRuntime.isBackendReady()) {
      return 'info';
    }
    return this.health.isOllamaMissing() ? 'danger' : 'success';
  }

  protected modelSeverity(): 'success' | 'danger' | 'info' | 'warn' {
    if (
      !this.desktopRuntime.isBackendReady() ||
      this.health.isOllamaMissing()
    ) {
      return 'info';
    }
    return this.health.isModelMissing()
      ? 'danger'
      : this.health.llmHealth()?.available
        ? 'success'
        : 'warn';
  }

  protected ocrSeverity(): 'success' | 'danger' | 'info' | 'warn' {
    if (!this.desktopRuntime.isBackendReady()) {
      return 'info';
    }
    return this.health.isOcrRuntimeMissing()
      ? 'danger'
      : this.health.ocrHealth()?.available
        ? 'success'
        : 'warn';
  }
}
