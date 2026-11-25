import { Component, ChangeDetectionStrategy } from '@angular/core';
import { DraftReviewPanelComponent } from '../../authoring/feature';
import { AppIconComponent } from '../ui';
import { SourceImportPanelComponent } from '../../source-library/feature';

@Component({
  selector: 'app-build-page',
  imports: [DraftReviewPanelComponent, SourceImportPanelComponent, AppIconComponent],
  templateUrl: './build.page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './build.page.css',
})
export class BuildPage {
  // A layout of the two panels with no state or logic: Question Authoring's
  // DraftReviewStore reloads the drafts on Source Library's document activity
  // (D19).
}
