import { Component, ChangeDetectionStrategy } from '@angular/core';
import { PracticePanelComponent } from '../../components/practice-panel/practice-panel.component';

@Component({
  selector: 'app-full-exam-page',
  imports: [PracticePanelComponent],
  templateUrl: './full-exam.page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './full-exam.page.css',
})
export class FullExamPage {}
