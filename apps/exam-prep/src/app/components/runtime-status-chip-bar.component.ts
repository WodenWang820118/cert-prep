import { Component, EventEmitter, Input, Output } from '@angular/core';
import { Button } from 'primeng/button';
import { Tag } from 'primeng/tag';
import type { RuntimeStatusChipView } from './model-health.view-model';

@Component({
  selector: 'app-runtime-status-chip-bar',
  imports: [Button, Tag],
  template: `
    <div
      class="flex flex-wrap items-center justify-end gap-2 rounded-lg border border-surface-200 bg-surface-0 p-2 shadow-sm"
    >
      <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        @for (chip of chips; track chip.label) {
          <p-tag
            [severity]="chip.severity"
            [value]="chip.label"
            [rounded]="true"
          />
        }
      </div>
      <p-button
        label="Manage runtime"
        icon="pi pi-sliders-h"
        severity="secondary"
        [outlined]="true"
        (onClick)="manageRuntime.emit()"
      />
    </div>
  `,
})
export class RuntimeStatusChipBarComponent {
  @Input({ required: true }) chips: readonly RuntimeStatusChipView[] = [];
  @Output() readonly manageRuntime = new EventEmitter<void>();
}
