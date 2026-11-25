import { Component, ChangeDetectionStrategy } from '@angular/core';
import { WrongAnswerRetryComponent } from './wrong-answer-retry.component';

@Component({
  selector: 'app-wrong-answer-retry-page',
  imports: [WrongAnswerRetryComponent],
  templateUrl: './wrong-answer-retry.page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './wrong-answer-retry.page.css',
})
export class WrongAnswerRetryPage {}
