import { Component, Input, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ModelHealthViewModelFacade } from './model-health-view-model.facade';
import { RuntimeStatusChipBarComponent } from './runtime-status-chip-bar.component';

@Component({
  selector: 'app-model-health',
  imports: [RuntimeStatusChipBarComponent],
  template: `
    <app-runtime-status-chip-bar
      [chips]="viewModel().chips"
      [showManageButton]="showManageButton"
      (manageRuntime)="openRuntimeManager()"
    />
  `,
})
export class ModelHealthComponent {
  private readonly healthViewModels = inject(ModelHealthViewModelFacade);
  private readonly router = inject(Router);

  protected readonly viewModel = this.healthViewModels.viewModel;
  @Input() showManageButton = true;

  protected openRuntimeManager(): void {
    void this.router.navigateByUrl('/runtime');
  }
}
