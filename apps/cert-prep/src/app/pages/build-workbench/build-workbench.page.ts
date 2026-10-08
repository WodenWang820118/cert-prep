import { Component, ChangeDetectionStrategy } from '@angular/core';
import { DraftReviewPanelComponent } from '../../components/draft-review-panel/draft-review-panel.component';
import { SourceImportPanelComponent } from '../../components/source-import-panel/source-import-panel.component';
import { AppIconComponent } from '../../components/ui/app-icon.component';

@Component({
  selector: 'app-build-workbench-page',
  imports: [DraftReviewPanelComponent, SourceImportPanelComponent, AppIconComponent],
  templateUrl: './build-workbench.page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './build-workbench.page.css',
})
export class BuildWorkbenchPage {}
