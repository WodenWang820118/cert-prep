import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { DraftReviewPanelComponent } from '../../components/draft-review-panel/draft-review-panel.component';
import { AppIconComponent } from '../../core/ui';
import { SourceImportPanelComponent } from '../../source-library/feature';
import { DraftReviewStore } from '../../stores/draft-review/draft-review.store';

@Component({
  selector: 'app-build-workbench-page',
  imports: [DraftReviewPanelComponent, SourceImportPanelComponent, AppIconComponent],
  templateUrl: './build-workbench.page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './build-workbench.page.css',
})
export class BuildWorkbenchPage {
  // Source Library is upstream of Authoring (D18): the source panel reports
  // source document activity and this page reloads the project's drafts.
  protected readonly drafts = inject(DraftReviewStore);
}
