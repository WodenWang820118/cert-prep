import {
  Component,
  EventEmitter,
  Input,
  Output,
  computed,
  inject,
  ChangeDetectionStrategy
} from '@angular/core';
import { ModelHealthViewModelFacade } from '../../components/model-health/model-health-view-model.facade';
import { RuntimeStatusRowComponent } from '../../components/model-health/runtime-status-row.component';
import { DesktopRuntimeStore } from '../../stores/desktop-runtime/desktop-runtime.store';
import { HealthStore } from '../../stores/health/health.store';
import { OperationStore } from '../../stores/operation.store';
import { ActionButtonComponent } from '../../components/ui/action-button.component';
import { AppIconComponent } from '../../components/ui/app-icon.component';
import { HlmProgressImports } from '@spartan-ng/helm/progress';

@Component({
  selector: 'app-runtime-manager-page',
  imports: [RuntimeStatusRowComponent, ActionButtonComponent, AppIconComponent, HlmProgressImports],
  templateUrl: './runtime-manager.page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './runtime-manager.page.css',
})
export class RuntimeManagerPage {
  @Input() modal = false;
  @Input() titleId = 'runtime-manager-route-title';
  @Output() readonly closeRequested = new EventEmitter<void>();

  protected readonly desktopRuntime = inject(DesktopRuntimeStore);
  protected readonly health = inject(HealthStore);
  protected readonly operations = inject(OperationStore);
  private readonly healthViewModels = inject(ModelHealthViewModelFacade);

  protected readonly viewModel = this.healthViewModels.viewModel;

  protected readonly modelDownloadActionLabel = computed(() =>
    this.health.modelDownload()?.phase === 'failed'
      ? `Retry ${this.health.configuredModelName()}`
      : `Download ${this.health.configuredModelName()}`,
  );

  protected readonly hasLlmRuntimeInstallation = computed(() => {
    const kind = this.health.runtimeInstall()?.kind;
    return kind === 'ollama';
  });

  protected refreshAll(): void {
    if (this.desktopRuntime.isBackendReady()) {
      this.health.refresh();
      return;
    }
    this.desktopRuntime.load().subscribe();
  }

  protected close(): void {
    if (this.modal) {
      this.closeRequested.emit();
    }
  }
}
