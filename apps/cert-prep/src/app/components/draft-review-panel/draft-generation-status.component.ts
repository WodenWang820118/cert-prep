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
import { AppIconComponent } from '../ui/app-icon.component';

@Component({
  selector: 'app-draft-generation-status',
  imports: [AppIconComponent],
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
