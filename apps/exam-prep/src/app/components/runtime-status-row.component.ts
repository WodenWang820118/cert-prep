import { Component, Input } from '@angular/core';
import { Tag } from 'primeng/tag';
import type { RuntimeStatusSectionView } from './model-health.view-model';

@Component({
  selector: 'app-runtime-status-row',
  imports: [Tag],
  template: `
    <div
      class="grid gap-2 rounded-md border border-surface-200 bg-surface-50 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
    >
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <p-tag
            [severity]="section.severity"
            [value]="section.statusLabel"
            [rounded]="true"
          />
          <strong class="truncate text-sm text-color">
            {{ section.title }}
          </strong>
        </div>
        <p class="m-0 mt-1 text-sm leading-5 text-muted-color">
          {{ section.detail }}
        </p>
      </div>
      <div class="flex flex-wrap gap-2 sm:justify-end">
        <ng-content select="[actions]" />
      </div>
      <ng-content select="[progress]" />
    </div>
  `,
})
export class RuntimeStatusRowComponent {
  @Input({ required: true }) section!: RuntimeStatusSectionView;
}
