import { Component, inject } from '@angular/core';
import { HealthStore } from '../stores/health.store';
import { OperationStore } from '../stores/operation.store';

@Component({
  selector: 'app-model-health',
  imports: [],
  template: `
    @if (health.health(); as modelHealth) {
      <span
        class="health-dot"
        [class.is-online]="modelHealth.available"
        aria-hidden="true"
      ></span>
      <div>
        <strong>{{ modelHealth.provider }} / {{ modelHealth.model }}</strong>
        <span>{{ modelHealth.detail }}</span>
      </div>
    } @else {
      <span class="health-dot" aria-hidden="true"></span>
      <div>
        <strong>Model health</strong>
        <span>Unavailable</span>
      </div>
    }
    <button
      class="ghost-button"
      type="button"
      [disabled]="operations.isBusy()"
      (click)="health.refresh()"
    >
      Refresh
    </button>
  `,
})
export class ModelHealthComponent {
  protected readonly health = inject(HealthStore);
  protected readonly operations = inject(OperationStore);
}
