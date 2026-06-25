import { Component, computed, inject } from '@angular/core';
import { Button } from 'primeng/button';
import { Dialog } from 'primeng/dialog';
import { DesktopRuntimeStore } from '../../stores/desktop-runtime/desktop-runtime.store';
import { HealthStore } from '../../stores/health/health.store';
import { RuntimeJobViewService } from '../../stores/health/runtime-job-view.service';

@Component({
  selector: 'app-runtime-consent-dialogs',
  imports: [Button, Dialog],
  template: `
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
          Download {{ health.configuredModelName() }} with
          {{ health.llmProviderLabel() }}?
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
        @if (health.runtimeInstallConsentKind() === 'windowsml_ocr') {
          <p class="m-0 text-sm leading-6 text-color">
            Install the WindowsML OCR runtime for image-only PDFs?
          </p>
          <p class="m-0 text-sm leading-6 text-muted-color">
            The runtime is downloaded from the release asset, verified, and
            extracted under your user app data. OCR can route through the
            WindowsML hardware stack while the Nvidia GPU remains available for
            reasoning.
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
export class RuntimeConsentDialogsComponent {
  protected readonly desktopRuntime = inject(DesktopRuntimeStore);
  protected readonly health = inject(HealthStore);
  private readonly runtimeJobs = inject(RuntimeJobViewService);

  protected readonly runtimeInstallConsentLabel = computed(() =>
    this.runtimeJobs.runtimeLabel(this.health.runtimeInstallConsentKind()),
  );
}
