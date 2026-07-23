import { Component, ChangeDetectionStrategy } from '@angular/core';
import { DraftReviewPanelComponent } from '../../components/draft-review-panel/draft-review-panel.component';
import { ModelHealthComponent } from '../../components/model-health/model-health.component';
import { SourceImportPanelComponent } from '../../components/source-import-panel/source-import-panel.component';

@Component({
  selector: 'app-build-workbench-page',
  imports: [
    DraftReviewPanelComponent,
    ModelHealthComponent,
    SourceImportPanelComponent,
  ],
  templateUrl: './build-workbench.page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './build-workbench.page.css',
})
export class BuildWorkbenchPage {}
