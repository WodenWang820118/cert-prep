import { Component, ChangeDetectionStrategy } from '@angular/core';
import { DraftReviewPanelComponent } from '../../authoring/feature';
import { AppIconComponent } from '../ui';
import { SourceImportPanelComponent } from '../../source-library/feature';

@Component({
  selector: 'app-build-workbench-page',
  imports: [DraftReviewPanelComponent, SourceImportPanelComponent, AppIconComponent],
  templateUrl: './build-workbench.page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './build-workbench.page.css',
})
export class BuildWorkbenchPage {
  // A layout of the two panels with no state or logic: Question Authoring's
  // DraftReviewStore reloads the drafts on Source Library's document activity
  // (D19).
}
