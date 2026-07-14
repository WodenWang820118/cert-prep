import { computed, inject, Injectable } from '@angular/core';
import type { ModelHealthViewModel } from './contracts/model-health.contracts';
import { ModelHealthViewModelService } from './model-health-view-model.service';
import { DesktopRuntimeStore } from '../../stores/desktop-runtime/desktop-runtime.store';
import { HealthStore } from '../../stores/health/health.store';

@Injectable({ providedIn: 'root' })
export class ModelHealthViewModelFacade {
  private readonly desktopRuntime = inject(DesktopRuntimeStore);
  private readonly health = inject(HealthStore);
  private readonly healthViewModels = inject(ModelHealthViewModelService);

  readonly viewModel = computed<ModelHealthViewModel>(() =>
    this.healthViewModels.create({
      backendReady: this.desktopRuntime.isBackendReady(),
      pythonRuntimeMissing: this.desktopRuntime.isPythonRuntimeMissing(),
      pythonInstallActive: this.desktopRuntime.isInstallActive(),
      desktopStatus: this.desktopRuntime.status(),
      desktopInstallDetail: this.desktopRuntime.installation()?.detail ?? null,
      systemHealth: this.health.systemHealth(),
      llmHealth: this.health.llmHealth(),
      providerSelection: this.health.providerSelection(),
      ocrHealth: this.health.ocrHealth(),
      ocrPhase: this.health.ocrPhase(),
      llmRuntimeMissing: this.health.isLlmRuntimeMissing(),
      modelMissing: this.health.isModelMissing(),
      ocrRuntimeMissing: this.health.isOcrRuntimeMissing(),
      configuredModelName: this.health.configuredModelName(),
      effectiveModelName: this.health.effectiveModelName(),
      modelFallbackActive: this.health.isModelFallbackActive(),
    }),
  );
}
