import { Component, computed, inject } from '@angular/core';
import { Button } from 'primeng/button';
import { ProgressBar } from 'primeng/progressbar';
import { ModelHealthViewModelFacade } from '../../components/model-health/model-health-view-model.facade';
import { RuntimeStatusRowComponent } from '../../components/model-health/runtime-status-row.component';
import { DesktopRuntimeStore } from '../../stores/desktop-runtime/desktop-runtime.store';
import { HealthStore } from '../../stores/health/health.store';
import { OperationStore } from '../../stores/operation.store';

@Component({
  selector: 'app-runtime-manager-page',
  imports: [Button, ProgressBar, RuntimeStatusRowComponent],
  templateUrl: './runtime-manager.page.html',
  styleUrl: './runtime-manager.page.css',
})
export class RuntimeManagerPage {
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

  protected async refreshAll(): Promise<void> {
    if (this.desktopRuntime.isBackendReady()) {
      await this.health.refresh();
      return;
    }
    await this.desktopRuntime.load();
  }
}
