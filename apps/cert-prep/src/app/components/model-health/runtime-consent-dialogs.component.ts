import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { DesktopRuntimeStore } from '../../stores/desktop-runtime/desktop-runtime.store';
import { HealthStore } from '../../stores/health/health.store';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { ActionButtonComponent } from '../ui/action-button.component';

@Component({
  selector: 'app-runtime-consent-dialogs',
  imports: [ActionButtonComponent, HlmDialogImports],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <hlm-dialog
      [state]="desktopRuntime.installConsentVisible() ? 'open' : 'closed'"
      [disableClose]="desktopRuntime.installStarting()"
      [closeOnOutsidePointerEvents]="false"
      (closed)="desktopRuntime.setInstallConsentVisible(false)"
    >
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="w-[min(92vw,34rem)] max-w-none sm:max-w-none"
        [showCloseButton]="!desktopRuntime.installStarting()"
      >
        <hlm-dialog-header
          ><h3 hlmDialogTitle class="text-lg font-semibold">
            Install Python backend runtime
          </h3></hlm-dialog-header
        >
        <div class="grid gap-3">
          <p class="m-0 text-sm leading-6 text-foreground">
            Download the packaged Python backend runtime?
          </p>
          <p class="m-0 text-sm leading-6 text-muted-foreground">
            The app verifies the downloaded runtime before it is extracted under
            your user app data.
          </p>
          <div class="flex flex-wrap justify-end gap-2 pt-2">
            <app-action-button
              label="Cancel"
              variant="outline"
              [disabled]="desktopRuntime.installStarting()"
              (pressed)="desktopRuntime.cancelInstallConsent()"
            />
            <app-action-button
              label="Install"
              icon="lucideDownload"
              variant="warn"
              [loading]="desktopRuntime.installStarting()"
              (pressed)="desktopRuntime.confirmPythonRuntimeInstallation()"
            />
          </div>
        </div>
      </hlm-dialog-content>
    </hlm-dialog>

    <hlm-dialog
      [state]="health.modelDownloadConsentVisible() ? 'open' : 'closed'"
      [disableClose]="health.modelDownloadStarting()"
      [closeOnOutsidePointerEvents]="false"
      (closed)="health.setModelDownloadConsentVisible(false)"
    >
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="w-[min(92vw,32rem)] max-w-none sm:max-w-none"
        [showCloseButton]="!health.modelDownloadStarting()"
      >
        <hlm-dialog-header
          ><h3 hlmDialogTitle class="text-lg font-semibold">Download reasoning model</h3></hlm-dialog-header
        >
        <div class="grid gap-3">
          <p class="m-0 text-sm leading-6 text-foreground">
            Download {{ health.configuredModelName() }} with
            {{ health.llmProviderLabel() }}?
          </p>
          <p class="m-0 text-sm leading-6 text-muted-foreground">
            This starts a background download and can take several minutes on a
            slower connection.
          </p>
          <div class="flex flex-wrap justify-end gap-2 pt-2">
            <app-action-button
              label="Cancel"
              variant="outline"
              [disabled]="health.modelDownloadStarting()"
              (pressed)="health.cancelModelDownloadConsent()"
            />
            <app-action-button
              label="Download"
              icon="lucideDownload"
              variant="warn"
              [loading]="health.modelDownloadStarting()"
              (pressed)="health.confirmModelDownload()"
            />
          </div>
        </div>
      </hlm-dialog-content>
    </hlm-dialog>

    <hlm-dialog
      [state]="health.runtimeInstallConsentVisible() ? 'open' : 'closed'"
      [disableClose]="health.runtimeInstallStarting()"
      [closeOnOutsidePointerEvents]="false"
      (closed)="health.setRuntimeInstallConsentVisible(false)"
    >
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="w-[min(92vw,34rem)] max-w-none sm:max-w-none"
        [showCloseButton]="!health.runtimeInstallStarting()"
      >
        <hlm-dialog-header
          ><h3 hlmDialogTitle class="text-lg font-semibold">Install Ollama</h3></hlm-dialog-header
        >
        <div class="grid gap-3">
          <p class="m-0 text-sm leading-6 text-foreground">
            Install Ollama for local AI generation?
          </p>
          <p class="m-0 text-sm leading-6 text-muted-foreground">
            This starts the official Windows installer. Return here and refresh
            the status if Windows asks for confirmation.
          </p>
          <div class="flex flex-wrap justify-end gap-2 pt-2">
            <app-action-button
              label="Cancel"
              variant="outline"
              [disabled]="health.runtimeInstallStarting()"
              (pressed)="health.cancelRuntimeInstallConsent()"
            />
            <app-action-button
              label="Install"
              icon="lucideDownload"
              variant="warn"
              [loading]="health.runtimeInstallStarting()"
              (pressed)="health.confirmRuntimeInstallation()"
            />
          </div>
        </div>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class RuntimeConsentDialogsComponent {
  protected readonly desktopRuntime = inject(DesktopRuntimeStore);
  protected readonly health = inject(HealthStore);
}
