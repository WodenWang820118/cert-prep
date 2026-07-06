import { Component, computed, inject, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { OperationStore } from '../../stores/operation.store';
import type { PracticeSessionMode } from '../../stores/practice/contracts/practice.contracts';
import { PracticeStore } from '../../stores/practice/practice.store';

interface QuestionNavigatorItem {
  readonly number: number;
  readonly state: 'answered' | 'current' | 'pending';
}

@Component({
  selector: 'app-practice-panel',
  imports: [FormsModule],
  templateUrl: './practice-panel.component.html',
  styleUrl: './practice-panel.component.css',
})
export class PracticePanelComponent {
  readonly sessionMode = input<PracticeSessionMode>('random_draw');

  protected readonly operations = inject(OperationStore);
  protected readonly practice = inject(PracticeStore);

  protected readonly modeTitle = computed(() =>
    this.sessionMode() === 'full_document' ? 'Full Exam' : 'Random Quiz',
  );

  protected readonly modeSummary = computed(() => {
    if (this.sessionMode() === 'full_document') {
      return `${this.practice.selectedDocumentQuestionCount()} questions in selected document`;
    }

    return `${this.practice.questionCount()} questions available`;
  });

  protected readonly startButtonLabel = computed(() =>
    this.sessionMode() === 'full_document'
      ? 'Start full exam'
      : 'Start random quiz',
  );

  protected readonly sessionTotal = computed(() => {
    const session = this.practice.practiceSession();
    if (session !== null) {
      return session.questions.length > 0
        ? session.questions.length
        : session.question_ids.length;
    }

    return this.sessionMode() === 'full_document'
      ? this.practice.selectedDocumentQuestionCount()
      : this.practice.effectiveRandomQuestionCount();
  });

  protected readonly answeredCount = computed(
    () => this.practice.answeredQuestionIds().size,
  );

  protected readonly progressPercent = computed(() => {
    const total = this.sessionTotal();
    return total === 0 ? 0 : Math.round((this.answeredCount() / total) * 100);
  });

  protected readonly activeQuestionNumber = computed(() => {
    const session = this.practice.practiceSession();
    const question = this.practice.activeQuestion();
    if (session === null || question === null) {
      return Math.min(
        this.answeredCount() + 1,
        Math.max(this.sessionTotal(), 1),
      );
    }

    const questionIds =
      session.questions.length > 0
        ? session.questions.map((snapshotQuestion) => snapshotQuestion.id)
        : session.question_ids;
    const index = questionIds.indexOf(question.id);
    return index === -1 ? this.answeredCount() + 1 : index + 1;
  });

  protected choiceKey(index: number): string {
    return choiceKey(index);
  }

  protected readonly questionNavigatorItems = computed<
    readonly QuestionNavigatorItem[]
  >(() => {
    const total = this.sessionTotal();
    const current = this.activeQuestionNumber();
    const answered = this.answeredCount();

    return Array.from({ length: total }, (_, index) => {
      const number = index + 1;
      if (number <= answered) {
        return { number, state: 'answered' };
      }
      if (number === current && this.practice.practiceSession() !== null) {
        return { number, state: 'current' };
      }
      return { number, state: 'pending' };
    });
  });

  protected async startPracticeSession(): Promise<void> {
    await this.practice.createPracticeSession(this.sessionMode());
  }
}

function choiceKey(index: number): string {
  let value = index + 1;
  let key = '';
  while (value > 0) {
    value -= 1;
    key = String.fromCharCode(65 + (value % 26)) + key;
    value = Math.floor(value / 26);
  }
  return key;
}
