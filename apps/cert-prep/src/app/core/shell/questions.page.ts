import { Component, ChangeDetectionStrategy } from '@angular/core';
import { QuestionsPanelComponent } from '../../authoring/feature';
import { AppIconComponent } from '../ui';
import { SourceImportPanelComponent } from '../../source-library/feature';

@Component({
  selector: 'app-questions-page',
  imports: [QuestionsPanelComponent, SourceImportPanelComponent, AppIconComponent],
  templateUrl: './questions.page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './questions.page.css',
})
export class QuestionsPage {
  // A layout of the two panels with no state or logic: Question Authoring's
  // QuestionsStore reloads the questions on Source Library's source activity
  // (D19).
}
