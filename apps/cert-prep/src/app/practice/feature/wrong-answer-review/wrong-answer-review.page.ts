import { Component, ChangeDetectionStrategy } from '@angular/core';
import { WrongAnswerReviewComponent } from './wrong-answer-review.component';

@Component({
  selector: 'app-wrong-answer-review-page',
  imports: [WrongAnswerReviewComponent],
  templateUrl: './wrong-answer-review.page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './wrong-answer-review.page.css',
})
export class WrongAnswerReviewPage {}
