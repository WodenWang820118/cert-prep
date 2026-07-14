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
      [closable]="
        !health.modelDownloadStarting() &&
        !health.fastFlowTermsDecisionPending()
      "
      [closeOnEscape]="
        !health.modelDownloadStarting() &&
        !health.fastFlowTermsDecisionPending()
      "
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
        @if (health.fastFlowTermsConsentRequired()) {
          <div class="fastflow-terms-panel">
            @if (health.fastFlowTerms(); as terms) {
              <p class="m-0 text-sm leading-6 text-muted-color">
                Cert Prep downloads the model through the official FastFlowLM
                channel. Review the pinned v{{ terms.version }} original terms
                before continuing.
              </p>
              <a
                class="fastflow-terms-link"
                [href]="terms.url"
                target="_blank"
                rel="noopener noreferrer"
              >
                Read FastFlowLM v{{ terms.version }} terms
              </a>
              <label class="fastflow-terms-check" for="fastflow-model-terms">
                <input
                  id="fastflow-model-terms"
                  type="checkbox"
                  [checked]="health.fastFlowTermsAcknowledged()"
                  [disabled]="
                    health.modelDownloadStarting() ||
                    health.fastFlowTermsDecisionPending()
                  "
                  (change)="updateTermsAcknowledgement($event)"
                />
                <span>
                  I have read and accept the FastFlowLM v{{ terms.version }}
                  terms.
                </span>
              </label>
            } @else {
              <p class="fastflow-terms-error" role="alert">
                FastFlowLM terms metadata is unavailable. Installation is
                blocked; decline to continue with Ollama.
              </p>
            }
          </div>
        }
        <div class="flex flex-wrap justify-end gap-2 pt-2">
          <p-button
            label="Cancel"
            severity="secondary"
            [outlined]="true"
            [disabled]="
              health.modelDownloadStarting() ||
              health.fastFlowTermsDecisionPending()
            "
            (onClick)="health.cancelModelDownloadConsent()"
          />
          @if (health.fastFlowTermsConsentRequired()) {
            <p-button
              label="Decline and use Ollama"
              severity="secondary"
              [outlined]="true"
              [loading]="health.fastFlowTermsDecisionPending()"
              [disabled]="health.modelDownloadStarting()"
              (onClick)="declineFastFlowTerms()"
            />
          }
          <p-button
            label="Download"
            icon="pi pi-download"
            severity="warn"
            [loading]="health.modelDownloadStarting()"
            [disabled]="!health.canConfirmFastFlowTerms()"
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
      [closable]="
        !health.runtimeInstallStarting() &&
        !health.fastFlowTermsDecisionPending()
      "
      [closeOnEscape]="
        !health.runtimeInstallStarting() &&
        !health.fastFlowTermsDecisionPending()
      "
      [dismissableMask]="false"
      [style]="{ width: 'min(92vw, 34rem)' }"
      (visibleChange)="health.setRuntimeInstallConsentVisible($event)"
    >
      <div class="grid gap-3">
        @if (health.runtimeInstallConsentKind() === 'fastflowlm') {
          <p class="m-0 text-sm leading-6 text-color">
            Install FastFlowLM from its official pinned release for local NPU
            generation?
          </p>
          <p class="m-0 text-sm leading-6 text-muted-color">
            Cert Prep verifies the pinned download size, SHA-256, Authenticode
            signature, timestamp, signer subject, and signer thumbprint before
            launching the official installer. The binary is not bundled or
            mirrored by Cert Prep.
          </p>
        } @else if (health.runtimeInstallConsentKind() === 'windowsml_ocr') {
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
        @if (health.fastFlowTermsConsentRequired()) {
          <div class="fastflow-terms-panel">
            @if (health.fastFlowTerms(); as terms) {
              <p class="m-0 text-sm leading-6 text-muted-color">
                Review the original publisher terms for the exact pinned
                runtime version before the official installer is requested.
              </p>
              <a
                class="fastflow-terms-link"
                [href]="terms.url"
                target="_blank"
                rel="noopener noreferrer"
              >
                Read FastFlowLM v{{ terms.version }} terms
              </a>
              <label class="fastflow-terms-check" for="fastflow-runtime-terms">
                <input
                  id="fastflow-runtime-terms"
                  type="checkbox"
                  [checked]="health.fastFlowTermsAcknowledged()"
                  [disabled]="
                    health.runtimeInstallStarting() ||
                    health.fastFlowTermsDecisionPending()
                  "
                  (change)="updateTermsAcknowledgement($event)"
                />
                <span>
                  I have read and accept the FastFlowLM v{{ terms.version }}
                  terms.
                </span>
              </label>
            } @else {
              <p class="fastflow-terms-error" role="alert">
                FastFlowLM terms metadata is unavailable. Installation is
                blocked; decline to continue with Ollama.
              </p>
            }
          </div>
        }
        <div class="flex flex-wrap justify-end gap-2 pt-2">
          <p-button
            label="Cancel"
            severity="secondary"
            [outlined]="true"
            [disabled]="
              health.runtimeInstallStarting() ||
              health.fastFlowTermsDecisionPending()
            "
            (onClick)="health.cancelRuntimeInstallConsent()"
          />
          @if (health.fastFlowTermsConsentRequired()) {
            <p-button
              label="Decline and use Ollama"
              severity="secondary"
              [outlined]="true"
              [loading]="health.fastFlowTermsDecisionPending()"
              [disabled]="health.runtimeInstallStarting()"
              (onClick)="declineFastFlowTerms()"
            />
          }
          <p-button
            label="Install"
            icon="pi pi-download"
            severity="warn"
            [loading]="health.runtimeInstallStarting()"
            [disabled]="!health.canConfirmFastFlowTerms()"
            (onClick)="health.confirmRuntimeInstallation()"
          />
        </div>
      </div>
    </p-dialog>
  `,
  styles: `
    .fastflow-terms-panel {
      display: grid;
      gap: 0.75rem;
      border: 1px solid var(--workbench-border, #c2c6d4);
      border-radius: 0.625rem;
      background: var(--workbench-surface-low, #f8f9fa);
      padding: 0.875rem;
    }

    .fastflow-terms-link {
      width: fit-content;
      color: var(--workbench-primary, #00488d);
      font-size: 0.875rem;
      font-weight: 750;
      text-decoration: underline;
      text-underline-offset: 0.2em;
    }

    .fastflow-terms-check {
      display: flex;
      align-items: flex-start;
      gap: 0.625rem;
      color: var(--workbench-text, #191c1d);
      cursor: pointer;
      font-size: 0.875rem;
      line-height: 1.45;
    }

    .fastflow-terms-check input {
      width: 1rem;
      height: 1rem;
      margin-top: 0.15rem;
      accent-color: var(--workbench-primary, #00488d);
    }

    .fastflow-terms-error {
      margin: 0;
      color: var(--p-red-700, #b91c1c);
      font-size: 0.875rem;
      line-height: 1.45;
    }
  `,
})
export class RuntimeConsentDialogsComponent {
  protected readonly desktopRuntime = inject(DesktopRuntimeStore);
  protected readonly health = inject(HealthStore);
  private readonly runtimeJobs = inject(RuntimeJobViewService);

  protected readonly runtimeInstallConsentLabel = computed(() =>
    this.runtimeJobs.runtimeLabel(this.health.runtimeInstallConsentKind()),
  );

  protected updateTermsAcknowledgement(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    this.health.setFastFlowTermsAcknowledged(input?.checked === true);
  }

  protected async declineFastFlowTerms(): Promise<void> {
    await this.health.declineFastFlowTerms();
  }
}
