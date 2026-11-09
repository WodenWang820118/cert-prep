import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import type {
  DraftQuestionEditorAction,
  DraftQuestionEditorViewModel,
} from '../../domain';
import { formatChoiceKey } from '../../domain';
import { displayChoice } from '../../domain';
import { AiInferredAnswerBadgeComponent } from '../../../core/ui';
import { AppIconComponent } from '../../../core/ui';
import { HlmInput } from '@spartan-ng/helm/input';

@Component({
  selector: 'app-draft-question-editor-card',
  imports: [AiInferredAnswerBadgeComponent, AppIconComponent, HlmInput],
  templateUrl: './draft-question-editor-card.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class DraftQuestionEditorCardComponent {
  readonly model = input.required<DraftQuestionEditorViewModel>();
  readonly action = output<DraftQuestionEditorAction>();
  protected readonly displayChoice = displayChoice;

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
