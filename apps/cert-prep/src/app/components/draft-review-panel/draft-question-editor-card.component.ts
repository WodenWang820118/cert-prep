import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import type {
  DraftQuestionEditorAction,
  DraftQuestionEditorViewModel,
} from './draft-review-panel.contracts';
import { formatChoiceKey } from './draft-review-panel.formatters';
import { AppIconComponent } from '../ui/app-icon.component';
import { HlmInput } from '@spartan-ng/helm/input';

@Component({
  selector: 'app-draft-question-editor-card',
  imports: [AppIconComponent, HlmInput],
  templateUrl: './draft-question-editor-card.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class DraftQuestionEditorCardComponent {
  readonly model = input.required<DraftQuestionEditorViewModel>();
  readonly action = output<DraftQuestionEditorAction>();

  protected choiceKey(index: number): string {
    return formatChoiceKey(index);
  }

  protected emit(action: DraftQuestionEditorAction): void {
    this.action.emit(action);
  }

  protected valueFrom(event: Event): string {
    return (
      event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    ).value;
  }
}
