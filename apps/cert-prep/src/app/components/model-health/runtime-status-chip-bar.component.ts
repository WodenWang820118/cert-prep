import { Component, EventEmitter, Input, Output, ChangeDetectionStrategy } from '@angular/core';
import { Button } from 'primeng/button';
import { Tag } from 'primeng/tag';
import type { RuntimeStatusChipView } from './contracts/model-health.contracts';

@Component({
  selector: 'app-runtime-status-chip-bar',
  imports: [Button, Tag],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="runtime-chip-bar">
      <div class="runtime-chip-list">
        @for (chip of chips; track chip.label) {
          <p-tag
            [severity]="chip.severity"
            [value]="chip.label"
            [rounded]="true"
          />
        }
      </div>
      @if (showManageButton) {
        <p-button
          label="Manage runtime"
          icon="pi pi-sliders-h"
          severity="secondary"
          [outlined]="true"
          (onClick)="manageRuntime.emit()"
        />
      }
    </div>
  `,
})
export class RuntimeStatusChipBarComponent {
  @Input({ required: true }) chips: readonly RuntimeStatusChipView[] = [];
  @Input() showManageButton = true;
  @Output() readonly manageRuntime = new EventEmitter<void>();
}
