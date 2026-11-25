import { computed, inject, Injectable } from '@angular/core';
import type { RuntimeHealthViewModel } from '../domain';
import { RuntimeHealthViewModelService } from './runtime-health-view-model.service';
import { DesktopRuntimeStore } from './desktop-runtime.store';
import { HealthStore } from './health.store';

@Injectable({ providedIn: 'root' })
export class RuntimeHealthViewModelFacade {
  private readonly desktopRuntime = inject(DesktopRuntimeStore);
  private readonly health = inject(HealthStore);
  private readonly healthViewModels = inject(RuntimeHealthViewModelService);

  readonly viewModel = computed<RuntimeHealthViewModel>(() =>
    this.healthViewModels.create({
      backendReady: this.desktopRuntime.isBackendReady(),
      pythonRuntimeMissing: this.desktopRuntime.isPythonRuntimeMissing(),
      pythonInstallActive: this.desktopRuntime.isInstallActive(),
      desktopStatus: this.desktopRuntime.status(),
      desktopInstallDetail: this.desktopRuntime.installation()?.detail ?? null,
      systemHealth: this.health.systemHealth(),
      llmHealth: this.health.llmHealth(),
      providerSelection: this.health.providerSelection(),
      llmRuntimeMissing: this.health.isLlmRuntimeMissing(),
      modelMissing: this.health.isModelMissing(),
      configuredModelName: this.health.configuredModelName(),
      effectiveModelName: this.health.effectiveModelName(),
    }),
  );
}
