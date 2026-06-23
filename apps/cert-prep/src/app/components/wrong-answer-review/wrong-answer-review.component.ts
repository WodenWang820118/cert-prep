import { Component, inject } from '@angular/core';
import { Button } from 'primeng/button';
import { Card } from 'primeng/card';
import { Tag } from 'primeng/tag';
import { OperationStore } from '../../stores/operation.store';
import { ProjectStore } from '../../stores/project.store';
import { WrongAnswerReviewStore } from '../../stores/wrong-answer-review.store';

@Component({
  selector: 'app-wrong-answer-review',
  imports: [Button, Card, Tag],
  templateUrl: './wrong-answer-review.component.html',
  styleUrl: './wrong-answer-review.component.css',
})
export class WrongAnswerReviewComponent {
  protected readonly operations = inject(OperationStore);
  protected readonly projects = inject(ProjectStore);
  protected readonly review = inject(WrongAnswerReviewStore);
}
