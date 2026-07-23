import { Component, ChangeDetectionStrategy } from '@angular/core';
import { PracticePanelComponent } from '../../components/practice-panel/practice-panel.component';

@Component({
  selector: 'app-random-quiz-page',
  imports: [PracticePanelComponent],
  templateUrl: './random-quiz.page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './random-quiz.page.css',
})
export class RandomQuizPage {}
