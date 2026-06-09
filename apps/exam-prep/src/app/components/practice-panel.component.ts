import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Button } from 'primeng/button';
import { Card } from 'primeng/card';
import { InputText } from 'primeng/inputtext';
import { Message } from 'primeng/message';
import { RadioButton } from 'primeng/radiobutton';
import { Tag } from 'primeng/tag';
import { DraftReviewStore } from '../stores/draft-review.store';
import { OperationStore } from '../stores/operation.store';
import { PracticeStore } from '../stores/practice.store';

@Component({
  selector: 'app-practice-panel',
  imports: [Button, Card, FormsModule, InputText, Message, RadioButton, Tag],
  template: `
    <p-card styleClass="exam-card">
      <div class="grid gap-4">
        <div
          class="grid gap-3 md:grid-cols-[2.25rem_minmax(0,1fr)_auto] md:items-start"
        >
          <span
            class="grid h-9 w-9 place-items-center rounded-md border border-primary-200 bg-primary-50 text-sm font-bold text-primary"
          >
            03
          </span>
          <div class="min-w-0">
            <h2 id="practice-heading" class="m-0 text-base font-bold text-color">
              Practice Session
            </h2>
            <p class="m-0 mt-1 text-sm text-muted-color">
              {{ practice.sessionProgress() }} answered
            </p>
          </div>
          @if (practice.practiceSession(); as session) {
            <p-tag [value]="session.status" severity="info" [rounded]="true" />
          }
        </div>

        <div class="grid gap-3 md:grid-cols-[10rem_auto] md:items-end">
          <label class="grid gap-1.5 text-sm font-semibold text-muted-color">
            <span>Questions</span>
            <input
              pInputText
              name="sessionQuestionCount"
              type="number"
              min="1"
              max="100"
              [ngModel]="practice.sessionQuestionCount()"
              (ngModelChange)="practice.setSessionQuestionCount($event)"
            />
          </label>
          <p-button
            label="Create practice session"
            icon="pi pi-play"
            type="button"
            [disabled]="operations.isBusy() || drafts.approvedDrafts().length === 0"
            (onClick)="practice.createPracticeSession()"
          />
        </div>

        @if (practice.practiceSession(); as session) {
          <div
            class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-surface-200 bg-surface-50 px-3 py-2 text-sm font-semibold text-color"
          >
            <span>Session {{ session.id }}</span>
            <span class="text-muted-color">{{ session.status }}</span>
          </div>
        }

        @if (practice.activeQuestion(); as question) {
          <article class="grid gap-4 rounded-lg border border-surface-200 bg-surface-0 p-4">
            <h3 class="m-0 text-base font-semibold leading-6 text-color">
              {{ question.question }}
            </h3>
            <fieldset class="m-0 grid gap-2 border-0 p-0">
              <legend class="pb-1 text-sm font-bold text-muted-color">
                Choices
              </legend>
              @for (choice of question.choices; track $index) {
                <div
                  class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-md border border-surface-200 bg-surface-50 p-3"
                >
                  <p-radiobutton
                    name="practiceAnswer"
                    [inputId]="'practice-choice-' + $index"
                    [value]="choice"
                    [ngModel]="practice.selectedAnswer()"
                    (ngModelChange)="practice.selectAnswer($event)"
                  />
                  <label
                    class="text-sm text-color"
                    [for]="'practice-choice-' + $index"
                  >
                    {{ choice }}
                  </label>
                </div>
              }
            </fieldset>
            <p-button
              label="Submit answer"
              icon="pi pi-send"
              type="button"
              [disabled]="operations.isBusy() || practice.selectedAnswer().length === 0"
              (onClick)="practice.submitAnswer()"
            />
          </article>
        } @else if (practice.sessionComplete()) {
          <p
            class="m-0 rounded-lg border border-dashed border-surface-300 bg-surface-0 p-3 text-sm text-muted-color"
          >
            Practice set complete.
          </p>
        } @else {
          <p
            class="m-0 rounded-lg border border-dashed border-surface-300 bg-surface-0 p-3 text-sm text-muted-color"
          >
            No active practice question.
          </p>
        }

        @if (practice.lastAttempt(); as attempt) {
          <p-message
            [severity]="attempt.is_correct ? 'success' : 'warn'"
            [text]="attempt.is_correct ? 'Last answer: Correct' : 'Last answer: Needs review'"
          />
        }
      </div>
    </p-card>
  `,
})
export class PracticePanelComponent {
  protected readonly drafts = inject(DraftReviewStore);
  protected readonly operations = inject(OperationStore);
  protected readonly practice = inject(PracticeStore);
}
