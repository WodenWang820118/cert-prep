import { Component, ChangeDetectionStrategy } from '@angular/core';
import { WrongAnswerSummaryComponent } from './wrong-answer-summary.component';

@Component({
  selector: 'app-wrong-answer-summary-page',
  imports: [WrongAnswerSummaryComponent],
  templateUrl: './wrong-answer-summary.page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './wrong-answer-summary.page.css',
})
export class WrongAnswerSummaryPage {}
