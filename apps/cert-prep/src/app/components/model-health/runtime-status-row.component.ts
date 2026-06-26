import { Component, Input } from '@angular/core';
import { Tag } from 'primeng/tag';
import type { RuntimeStatusSectionView } from './contracts/model-health.contracts';

@Component({
  selector: 'app-runtime-status-row',
  imports: [Tag],
  template: `
    <div
      class="runtime-status-row"
    >
      <div class="runtime-status-row-copy">
        <h3>{{ section.title }}</h3>
        <p>
          {{ section.detail }}
        </p>
      </div>
      <p-tag
        styleClass="runtime-status-row-tag"
        [severity]="section.severity"
        [value]="section.statusLabel"
        [rounded]="false"
      />
      <div class="runtime-status-row-actions">
        <ng-content select="[actions]" />
      </div>
      <ng-content select="[progress]" />
    </div>
  `,
  styles: [
    `
      .runtime-status-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto minmax(5.5rem, auto);
        align-items: center;
        gap: 1rem;
        border-bottom: 1px solid var(--workbench-border, #c2c6d4);
        background: var(--workbench-surface, #ffffff);
        padding: 1rem;
      }

      .runtime-status-row:hover {
        background: var(--workbench-surface-low, #f8f9fa);
      }

      .runtime-status-row:first-child {
        border-top-left-radius: 8px;
        border-top-right-radius: 8px;
      }

      .runtime-status-row:last-child {
        border-bottom: 0;
        border-bottom-right-radius: 8px;
        border-bottom-left-radius: 8px;
      }

      .runtime-status-row-copy {
        min-width: 0;
      }

      .runtime-status-row-copy h3,
      .runtime-status-row-copy p {
        margin: 0;
      }

      .runtime-status-row-copy h3 {
        color: var(--workbench-text, #191c1d);
        font-size: 0.875rem;
        font-weight: 800;
        line-height: 1.25rem;
      }

      .runtime-status-row-copy p {
        margin-top: 0.25rem;
        color: var(--workbench-muted, #424752);
        font-size: 0.8125rem;
        line-height: 1.25rem;
      }

      .runtime-status-row-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 0.5rem;
      }

      :host ::ng-deep .runtime-status-row-tag {
        border-radius: 6px;
        font-size: 0.6875rem;
        font-weight: 800;
        letter-spacing: 0;
        text-transform: uppercase;
      }

      ::ng-deep .runtime-status-row-actions .p-button {
        min-height: 2rem;
        padding: 0.375rem 0.625rem;
        font-size: 0.75rem;
        font-weight: 800;
      }

      @media (max-width: 680px) {
        .runtime-status-row {
          grid-template-columns: 1fr;
          align-items: start;
        }

        .runtime-status-row-actions {
          justify-content: flex-start;
        }
      }
    `,
  ],
})
export class RuntimeStatusRowComponent {
  @Input({ required: true }) section!: RuntimeStatusSectionView;
}
