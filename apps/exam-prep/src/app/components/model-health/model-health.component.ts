import { Component, computed, effect, inject, signal } from '@angular/core';
import { Button } from 'primeng/button';
import { Dialog } from 'primeng/dialog';
import type { ModelHealthViewModel } from './contracts/model-health.contracts';
import { ModelHealthViewModelService } from './model-health-view-model.service';
import { RuntimeManagerDialogComponent } from './runtime-manager-dialog.component';
import { RuntimeStatusChipBarComponent } from './runtime-status-chip-bar.component';
import { DesktopRuntimeStore } from '../../stores/desktop-runtime/desktop-runtime.store';
import { HealthStore } from '../../stores/health/health.store';
import { RuntimeJobViewService } from '../../stores/health/runtime-job-view.service';
import { WorkspaceFacade } from '../../stores/workspace.facade';

@Component({
  selector: 'app-model-health',
  imports: [
    Button,
    Dialog,
    RuntimeManagerDialogComponent,
    RuntimeStatusChipBarComponent,
  ],
  template: `
    <app-runtime-status-chip-bar
      [chips]="viewModel().chips"
      (manageRuntime)="runtimeDialogVisible.set(true)"
    />

    <app-runtime-manager-dialog
      [viewModel]="viewModel()"
      [visible]="runtimeDialogVisible()"
      [modelDownloadActionLabel]="modelDownloadActionLabel()"
      (visibleChange)="runtimeDialogVisible.set($event)"
      (refreshAll)="refreshAll()"
    />

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
      [header]="'Install ' + runtimeInstallConsentLabel()"
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
        @if (health.runtimeInstallConsentKind() === 'directml_ocr') {
          <p class="m-0 text-sm leading-6 text-color">
            Install the AMD DirectML OCR runtime for image-only PDFs?
          </p>
          <p class="m-0 text-sm leading-6 text-muted-color">
            The runtime is downloaded from the release asset, verified, and
            extracted under your user app data. OCR stays on the AMD iGPU so
            the Nvidia GPU remains available for reasoning.
          </p>
        } @else if (health.runtimeInstallConsentKind() === 'paddle_ocr') {
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
  protected readonly runtimeDialogVisible = signal(false);
  private readonly healthViewModels = inject(ModelHealthViewModelService);
  private readonly runtimeJobs = inject(RuntimeJobViewService);
  private readonly workspace = inject(WorkspaceFacade);
  private loadingBackendState = false;

  protected readonly viewModel = computed<ModelHealthViewModel>(() =>
    this.healthViewModels.create({
      backendReady: this.desktopRuntime.isBackendReady(),
      pythonRuntimeMissing: this.desktopRuntime.isPythonRuntimeMissing(),
      pythonInstallActive: this.desktopRuntime.isInstallActive(),
      desktopStatus: this.desktopRuntime.status(),
      desktopInstallDetail: this.desktopRuntime.installation()?.detail ?? null,
      systemHealth: this.health.systemHealth(),
      llmHealth: this.health.llmHealth(),
      ocrHealth: this.health.ocrHealth(),
      ocrPhase: this.health.ocrPhase(),
      ollamaMissing: this.health.isOllamaMissing(),
      modelMissing: this.health.isModelMissing(),
      ocrRuntimeMissing: this.health.isOcrRuntimeMissing(),
      configuredModelName: this.health.configuredModelName(),
      effectiveModelName: this.health.effectiveModelName(),
      modelFallbackActive: this.health.isModelFallbackActive(),
    }),
  );
  protected readonly modelDownloadActionLabel = computed(() =>
    this.health.modelDownload()?.phase === 'failed'
      ? `Retry ${this.health.configuredModelName()}`
      : `Download ${this.health.configuredModelName()}`,
  );
  protected readonly runtimeInstallConsentLabel = computed(() =>
    this.runtimeJobs.runtimeLabel(this.health.runtimeInstallConsentKind()),
  );

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
}
