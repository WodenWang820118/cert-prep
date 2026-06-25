import { Component } from '@angular/core';
import { WrongAnswerReviewComponent } from '../../components/wrong-answer-review/wrong-answer-review.component';

@Component({
  selector: 'app-wrong-answer-review-page',
  imports: [WrongAnswerReviewComponent],
  templateUrl: './wrong-answer-review.page.html',
  styleUrl: './wrong-answer-review.page.css',
})
export class WrongAnswerReviewPage {}
