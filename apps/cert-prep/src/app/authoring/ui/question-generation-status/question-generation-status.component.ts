import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import type {
  QuestionGenerationAction,
  QuestionGenerationStatusViewModel,
} from '../../domain';
import { AppIconComponent } from '../../../core/ui';

@Component({
  selector: 'app-question-generation-status',
  imports: [AppIconComponent],
  templateUrl: './question-generation-status.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class QuestionGenerationStatusComponent {
  readonly model = input.required<QuestionGenerationStatusViewModel>();
  readonly action = output<QuestionGenerationAction>();

  protected emit(action: QuestionGenerationAction): void {
    this.action.emit(action);
  }
}
