import { Component, inject } from '@angular/core';
import { Button } from 'primeng/button';
import { Card } from 'primeng/card';
import { Tag } from 'primeng/tag';
import { OperationStore } from '../stores/operation.store';
import { ProjectStore } from '../stores/project.store';
import { WrongAnswerReviewStore } from '../stores/wrong-answer-review.store';

@Component({
  selector: 'app-wrong-answer-review',
  imports: [Button, Card, Tag],
  template: `
    <p-card styleClass="exam-card">
      <div class="grid gap-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="review-heading" class="m-0 text-base font-bold text-color">
              Wrong Answers
            </h2>
            <p class="m-0 mt-1 text-sm text-muted-color">
              {{ review.wrongAnswers().length }} recorded
            </p>
          </div>
          <p-button
            label="Refresh"
            icon="pi pi-refresh"
            severity="secondary"
            [outlined]="true"
            type="button"
            [disabled]="operations.isBusy() || projects.selectedProject() === null"
            (onClick)="review.refresh()"
          />
        </div>

        <div class="grid max-h-[calc(100vh-14rem)] gap-3 overflow-auto pr-1">
          @for (wrong of review.wrongAnswers(); track wrong.attempt_id) {
            <article
              class="grid gap-2 rounded-lg border border-surface-200 bg-surface-0 p-3"
            >
              <p-tag
                [value]="'Page ' + (wrong.citation_page ?? 'n/a')"
                severity="danger"
                [rounded]="true"
              />
              <h3 class="m-0 text-sm font-semibold leading-5 text-color">
                {{ wrong.question }}
              </h3>
              <p class="m-0 text-sm text-muted-color">
                Selected: {{ wrong.selected_answer }}
              </p>
              <p class="m-0 text-sm text-muted-color">
                Correct: {{ wrong.correct_answer ?? 'Not set' }}
              </p>
              @if (wrong.rationale) {
                <p class="m-0 text-sm leading-5 text-color">
                  {{ wrong.rationale }}
                </p>
              }
              @if (wrong.source_excerpt) {
                <blockquote
                  class="border-l-4 border-primary-300 bg-primary-50 px-3 py-2 text-sm leading-5 text-color"
                >
                  {{ wrong.source_excerpt }}
                </blockquote>
              }
            </article>
          } @empty {
            <p
              class="m-0 rounded-lg border border-dashed border-surface-300 bg-surface-0 p-3 text-sm text-muted-color"
            >
              No wrong answers recorded.
            </p>
          }
        </div>
      </div>
    </p-card>
  `,
})
export class WrongAnswerReviewComponent {
  protected readonly operations = inject(OperationStore);
  protected readonly projects = inject(ProjectStore);
  protected readonly review = inject(WrongAnswerReviewStore);
}
