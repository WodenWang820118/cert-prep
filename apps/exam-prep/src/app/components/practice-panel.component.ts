import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DraftReviewStore } from '../stores/draft-review.store';
import { OperationStore } from '../stores/operation.store';
import { PracticeStore } from '../stores/practice.store';

@Component({
  selector: 'app-practice-panel',
  imports: [FormsModule],
  template: `
    <div class="panel-heading">
      <span>03</span>
      <div>
        <h2 id="practice-heading">Practice Session</h2>
        <p>{{ practice.sessionProgress() }} answered</p>
      </div>
    </div>

    <div class="action-row">
      <label>
        <span>Questions</span>
        <input
          name="sessionQuestionCount"
          type="number"
          min="1"
          max="100"
          [ngModel]="practice.sessionQuestionCount()"
          (ngModelChange)="practice.setSessionQuestionCount($event)"
        />
      </label>
      <button
        class="primary-button"
        type="button"
        [disabled]="operations.isBusy() || drafts.approvedDrafts().length === 0"
        (click)="practice.createPracticeSession()"
      >
        Create practice session
      </button>
    </div>

    @if (practice.practiceSession(); as session) {
      <div class="session-strip">
        <span>Session {{ session.id }}</span>
        <span>{{ session.status }}</span>
      </div>
    }

    @if (practice.activeQuestion(); as question) {
      <article class="question-panel">
        <h3>{{ question.question }}</h3>
        <fieldset>
          <legend>Choices</legend>
          @for (choice of question.choices; track $index) {
            <label>
              <input
                type="radio"
                name="practiceAnswer"
                [checked]="practice.selectedAnswer() === choice"
                (change)="practice.selectAnswer(choice)"
              />
              <span>{{ choice }}</span>
            </label>
          }
        </fieldset>
        <button
          class="primary-button"
          type="button"
          [disabled]="operations.isBusy() || practice.selectedAnswer().length === 0"
          (click)="practice.submitAnswer()"
        >
          Submit answer
        </button>
      </article>
    } @else if (practice.sessionComplete()) {
      <p class="empty-state">Practice set complete.</p>
    } @else {
      <p class="empty-state">No active practice question.</p>
    }

    @if (practice.lastAttempt(); as attempt) {
      <p class="attempt-result" [class.is-correct]="attempt.is_correct">
        Last answer:
        @if (attempt.is_correct) {
          <strong>Correct</strong>
        } @else {
          <strong>Needs review</strong>
        }
      </p>
    }
  `,
})
export class PracticePanelComponent {
  protected readonly drafts = inject(DraftReviewStore);
  protected readonly operations = inject(OperationStore);
  protected readonly practice = inject(PracticeStore);
}
