import { Component } from '@angular/core';
import { PracticePanelComponent } from '../../components/practice-panel/practice-panel.component';

@Component({
  selector: 'app-random-quiz-page',
  imports: [PracticePanelComponent],
  templateUrl: './random-quiz.page.html',
  styleUrl: './random-quiz.page.css',
})
export class RandomQuizPage {}
