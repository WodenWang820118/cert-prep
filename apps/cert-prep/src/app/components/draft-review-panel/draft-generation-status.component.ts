import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import type {
  DraftGenerationAction,
  DraftGenerationStatusViewModel,
} from './draft-review-panel.contracts';

@Component({
  selector: 'app-draft-generation-status',
  templateUrl: './draft-generation-status.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class DraftGenerationStatusComponent {
  readonly model = input.required<DraftGenerationStatusViewModel>();
  readonly action = output<DraftGenerationAction>();

  protected emit(action: DraftGenerationAction): void {
    this.action.emit(action);
  }
}
