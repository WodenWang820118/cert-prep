import { Component, EventEmitter, Input, Output, ChangeDetectionStrategy } from '@angular/core';
import type { RuntimeStatusChipView } from './contracts/model-health.contracts';
import { ActionButtonComponent } from '../ui/action-button.component';
import { HlmBadge } from '@spartan-ng/helm/badge';

@Component({
  selector: 'app-runtime-status-chip-bar',
  imports: [ActionButtonComponent, HlmBadge],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="runtime-chip-bar">
      <div class="runtime-chip-list">
        @for (chip of chips; track chip.label) {
          <span hlmBadge [variant]="chip.severity">{{ chip.label }}</span>
        }
      </div>
      @if (showManageButton) {
        <app-action-button label="Manage runtime" icon="lucideSlidersHorizontal" variant="outline" (pressed)="manageRuntime.emit()" />
      }
    </div>
  `,
})
export class RuntimeStatusChipBarComponent {
  @Input({ required: true }) chips: readonly RuntimeStatusChipView[] = [];
  @Input() showManageButton = true;
  @Output() readonly manageRuntime = new EventEmitter<void>();
}
