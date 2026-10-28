import { ChangeDetectionStrategy, Component, input } from '@angular/core';

const AI_INFERRED_ANSWER_DESCRIPTION =
  'The answer was inferred by the local AI model and has not been confirmed. Check it against the source.';

/** Marks an answer key the local model inferred and nobody has confirmed. */
@Component({
  selector: 'app-ai-inferred-answer-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (source() === 'ai_inferred') {
      <span
        class="workbench-tag"
        data-testid="ai-inferred-answer"
        [attr.aria-description]="description"
      >
        AI-inferred answer
      </span>
    }
  `,
  styles: `
    :host {
      display: contents;
    }
  `,
})
export class AiInferredAnswerBadgeComponent {
  readonly source = input<string | null | undefined>(null);
  protected readonly description = AI_INFERRED_ANSWER_DESCRIPTION;
}
