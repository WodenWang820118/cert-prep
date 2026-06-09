import { Component, inject } from '@angular/core';
import { OperationStore } from '../stores/operation.store';
import { ProjectStore } from '../stores/project.store';
import { WrongAnswerReviewStore } from '../stores/wrong-answer-review.store';

@Component({
  selector: 'app-wrong-answer-review',
  imports: [],
  template: `
    <div class="review-heading">
      <h2 id="review-heading">Wrong Answers</h2>
      <button
        class="ghost-button"
        type="button"
        [disabled]="operations.isBusy() || projects.selectedProject() === null"
        (click)="review.refresh()"
      >
        Refresh
      </button>
    </div>

    <div class="review-list">
      @for (wrong of review.wrongAnswers(); track wrong.attempt_id) {
        <article class="review-item">
          <span>Page {{ wrong.citation_page ?? 'n/a' }}</span>
          <h3>{{ wrong.question }}</h3>
          <p>Selected: {{ wrong.selected_answer }}</p>
          <p>Correct: {{ wrong.correct_answer ?? 'Not set' }}</p>
          @if (wrong.rationale) {
            <p>{{ wrong.rationale }}</p>
          }
          @if (wrong.source_excerpt) {
            <blockquote>{{ wrong.source_excerpt }}</blockquote>
          }
        </article>
      } @empty {
        <p class="empty-state">No wrong answers recorded.</p>
      }
    </div>
  `,
})
export class WrongAnswerReviewComponent {
  protected readonly operations = inject(OperationStore);
  protected readonly projects = inject(ProjectStore);
  protected readonly review = inject(WrongAnswerReviewStore);
}
