import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  ElementRef,
  Input,
  OnChanges,
  Output,
  viewChildren,
} from '@angular/core';
import type {
  DeviceOptionView,
  DevicePreferenceUpdate,
  DeviceSectionViewModel,
} from '../domain';

@Component({
  selector: 'app-runtime-device-section',
  imports: [],
  template: `
    <section
      class="runtime-device-section"
      [attr.aria-labelledby]="groupId + '-title'"
    >
      <div class="runtime-device-header">
        <h3 [id]="groupId + '-title'" class="sr-only">{{ viewModel.title }}</h3>
      </div>

      @if (viewModel.externalNote; as note) {
        <div class="runtime-device-external-note" role="note">
          <p class="m-0">{{ note.meaning }}</p>
          <p class="m-0 mt-1">{{ note.action }}</p>
        </div>
      }

      @if (viewModel.showChooser) {
        <fieldset class="runtime-device-fieldset" [disabled]="viewModel.busy">
          <legend class="sr-only">選擇運算裝置</legend>
          <div class="runtime-device-options">
            @for (opt of viewModel.options; track opt.id) {
              <label
                class="runtime-device-option"
                [class.is-disabled]="opt.disabled || viewModel.busy"
                [class.is-checked]="opt.id === viewModel.selectedId"
                [for]="groupId + '-' + opt.id"
              >
                <input
                  #optionInput
                  type="radio"
                  [id]="groupId + '-' + opt.id"
                  [name]="groupId"
                  [value]="opt.value"
                  [checked]="opt.id === viewModel.selectedId"
                  [disabled]="opt.disabled || viewModel.busy"
                  (change)="onOptionSelect(opt)"
                />
                <div class="runtime-device-option-text">
                  <div class="runtime-device-option-main">
                    <span class="runtime-device-option-label">{{
                      opt.label
                    }}</span>
                    @if (opt.classificationLabel) {
                      <span class="runtime-device-option-classification">{{
                        opt.classificationLabel
                      }}</span>
                    }
                    @if (opt.backendLabel) {
                      <span class="runtime-device-option-backend">{{
                        opt.backendLabel
                      }}</span>
                    }
                  </div>
                  @if (opt.disabledNote) {
                    <p class="runtime-device-option-note">
                      {{ opt.disabledNote }}
                    </p>
                  }
                </div>
              </label>
            }
          </div>
        </fieldset>
      }

      @if (viewModel.statusLine; as status) {
        <p class="runtime-device-status-line" aria-live="polite">
          {{ status.text }}
        </p>
      }

      @if (viewModel.error; as err) {
        <p class="runtime-device-error" role="alert">
          {{ err }}
        </p>
      }
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .runtime-device-section {
        border-bottom: 1px solid var(--workbench-border, #c2c6d4);
        border-radius: 8px;
        background: var(--workbench-surface, #ffffff);
        padding: 1rem;
      }

      .runtime-device-header h3 {
        margin: 0;
        color: var(--workbench-text, #191c1d);
        font-size: 0.875rem;
        font-weight: 800;
        line-height: 1.25rem;
      }

      .runtime-device-external-note {
        margin: 0 0 0.75rem;
        border: 1px solid
          color-mix(in srgb, #f59e0b 35%, var(--workbench-border, #c2c6d4));
        border-radius: 6px;
        background: color-mix(
          in srgb,
          #f59e0b 8%,
          var(--workbench-surface, #ffffff)
        );
        padding: 0.75rem 1rem;
        color: var(--workbench-text, #191c1d);
        font-size: 0.8125rem;
        line-height: 1.25rem;
      }

      .runtime-device-fieldset {
        margin: 0;
        border: 0;
        padding: 0;
      }

      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border-width: 0;
      }

      .runtime-device-options {
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
      }

      .runtime-device-option {
        display: flex;
        align-items: flex-start;
        gap: 0.625rem;
        border-radius: 6px;
        padding: 0.375rem 0.5rem;
        cursor: pointer;
        transition: background-color 0.15s ease;
      }

      .runtime-device-option:hover:not(.is-disabled) {
        background: var(--workbench-surface-low, #f8f9fa);
      }

      .runtime-device-option.is-disabled {
        cursor: not-allowed;
        opacity: 0.6;
      }

      .runtime-device-option input[type='radio'] {
        margin-top: 0.1875rem;
        cursor: inherit;
      }

      .runtime-device-option-text {
        min-width: 0;
      }

      .runtime-device-option-main {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.875rem;
        line-height: 1.25rem;
      }

      .runtime-device-option-label {
        font-weight: 600;
        color: var(--workbench-text, #191c1d);
      }

      .runtime-device-option-classification {
        color: var(--workbench-muted, #424752);
        font-size: 0.8125rem;
      }

      .runtime-device-option-backend {
        border-radius: 4px;
        background: var(--workbench-surface-muted, #edeeef);
        padding: 0.0625rem 0.375rem;
        color: var(--workbench-muted, #424752);
        font-size: 0.75rem;
        font-weight: 600;
      }

      .runtime-device-option-note {
        margin: 0.125rem 0 0;
        color: var(--workbench-muted, #424752);
        font-size: 0.75rem;
        line-height: 1rem;
      }

      .runtime-device-status-line {
        margin: 0.75rem 0 0;
        color: var(--workbench-muted, #424752);
        font-size: 0.8125rem;
        line-height: 1.25rem;
      }

      .runtime-device-error {
        margin: 0.5rem 0 0;
        color: #d32f2f;
        font-size: 0.8125rem;
        font-weight: 600;
        line-height: 1.25rem;
      }
    `,
  ],
})
export class RuntimeDeviceSectionComponent implements OnChanges {
  private static nextId = 0;
  protected readonly groupId = `device-preference-${RuntimeDeviceSectionComponent.nextId++}`;
  private readonly optionInputs =
    viewChildren<ElementRef<HTMLInputElement>>('optionInput');
  @Input({ required: true }) viewModel!: DeviceSectionViewModel;
  @Output() readonly choose = new EventEmitter<DevicePreferenceUpdate>();

  ngOnChanges(): void {
    // Native radio selection changes even when a failed PUT leaves the model
    // unchanged. Restore the DOM as well as Angular's cached checked binding.
    if (!this.viewModel.busy) {
      const selectedInputId = `${this.groupId}-${this.viewModel.selectedId}`;
      for (const input of this.optionInputs()) {
        input.nativeElement.checked =
          input.nativeElement.id === selectedInputId;
      }
    }
  }

  protected onOptionSelect(opt: DeviceOptionView): void {
    if (opt.disabled || this.viewModel.busy) {
      return;
    }
    if (opt.mode === 'auto') {
      this.choose.emit({ mode: 'auto' });
    } else if (opt.mode === 'cpu') {
      this.choose.emit({ mode: 'cpu' });
    } else if (opt.mode === 'adapter' && opt.adapterKey) {
      this.choose.emit({ mode: 'adapter', adapter_key: opt.adapterKey });
    }
  }
}
