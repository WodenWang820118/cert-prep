import { Component, Input, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Button } from 'primeng/button';
import { Card } from 'primeng/card';
import { InputText } from 'primeng/inputtext';
import { Message } from 'primeng/message';
import { RadioButton } from 'primeng/radiobutton';
import { Tag } from 'primeng/tag';
import { OperationStore } from '../../stores/operation.store';
import type { PracticeSessionMode } from '../../stores/practice/contracts/practice.contracts';
import { PracticeStore } from '../../stores/practice/practice.store';

@Component({
  selector: 'app-practice-panel',
  imports: [Button, Card, FormsModule, InputText, Message, RadioButton, Tag],
  templateUrl: './practice-panel.component.html',
  styleUrl: './practice-panel.component.css',
})
export class PracticePanelComponent {
  @Input({ required: true }) sessionMode: PracticeSessionMode = 'random_draw';

  protected readonly operations = inject(OperationStore);
  protected readonly practice = inject(PracticeStore);

  protected modeTitle(): string {
    return this.sessionMode === 'full_document' ? 'Full Exam' : 'Random Quiz';
  }

  protected modeSummary(): string {
    if (this.sessionMode === 'full_document') {
      return `${this.practice.selectedDocumentQuestionCount()} questions in selected document`;
    }

    return `${this.practice.questionCount()} questions available`;
  }

  protected startButtonLabel(): string {
    return this.sessionMode === 'full_document'
      ? 'Start full exam'
      : 'Start random quiz';
  }

  protected async startPracticeSession(): Promise<void> {
    await this.practice.createPracticeSession(this.sessionMode);
  }
}
