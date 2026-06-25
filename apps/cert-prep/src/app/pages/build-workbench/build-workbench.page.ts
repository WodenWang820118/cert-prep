import { Component } from '@angular/core';
import { DraftReviewPanelComponent } from '../../components/draft-review-panel/draft-review-panel.component';
import { SourceImportPanelComponent } from '../../components/source-import-panel/source-import-panel.component';

@Component({
  selector: 'app-build-workbench-page',
  imports: [DraftReviewPanelComponent, SourceImportPanelComponent],
  templateUrl: './build-workbench.page.html',
  styleUrl: './build-workbench.page.css',
})
export class BuildWorkbenchPage {}
