import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import type {
  QuestionEditorAction,
  QuestionEditorViewModel,
} from '../../domain';
import { formatChoiceKey } from '../../domain';
import { displayChoice } from '../../domain';
import { AiInferredAnswerBadgeComponent } from '../../../core/ui';
import { AppIconComponent } from '../../../core/ui';
import { HlmInput } from '@spartan-ng/helm/input';

@Component({
  selector: 'app-question-editor-card',
  imports: [AiInferredAnswerBadgeComponent, AppIconComponent, HlmInput],
  templateUrl: './question-editor-card.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class QuestionEditorCardComponent {
  readonly model = input.required<QuestionEditorViewModel>();
  readonly action = output<QuestionEditorAction>();
  protected readonly displayChoice = displayChoice;

  protected choiceKey(index: number): string {
    return formatChoiceKey(index);
  }

  protected emit(action: QuestionEditorAction): void {
    this.action.emit(action);
  }

  protected valueFrom(event: Event): string {
    return (
      event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    ).value;
  }
}
