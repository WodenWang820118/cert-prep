import { Component, inject } from '@angular/core';
import { Button } from 'primeng/button';
import { Tag } from 'primeng/tag';
import { HealthStore } from '../stores/health.store';
import { OperationStore } from '../stores/operation.store';

@Component({
  selector: 'app-model-health',
  imports: [Button, Tag],
  template: `
    <div
      class="grid gap-3 rounded-lg border border-surface-200 bg-surface-0 p-3 shadow-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
    >
      @if (health.health(); as modelHealth) {
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <p-tag
              [severity]="modelHealth.available ? 'success' : 'danger'"
              [value]="modelHealth.available ? 'Online' : 'Offline'"
              [rounded]="true"
            />
            <strong class="truncate text-sm text-color">
              {{ modelHealth.provider }} / {{ modelHealth.model }}
            </strong>
          </div>
          <p class="m-0 mt-1 text-sm leading-5 text-muted-color">
            {{ modelHealth.detail }}
          </p>
        </div>
      } @else {
        <div>
          <div class="flex items-center gap-2">
            <p-tag severity="danger" value="Offline" [rounded]="true" />
            <strong class="text-sm text-color">Model health</strong>
          </div>
          <p class="m-0 mt-1 text-sm text-muted-color">Unavailable</p>
        </div>
      }
      <p-button
        label="Refresh"
        icon="pi pi-refresh"
        severity="secondary"
        [outlined]="true"
        [disabled]="operations.isBusy()"
        (onClick)="health.refresh()"
      />
    </div>
  `,
})
export class ModelHealthComponent {
  protected readonly health = inject(HealthStore);
  protected readonly operations = inject(OperationStore);
}
