import { Component, inject, OnInit } from '@angular/core';
import { DraftReviewPanelComponent } from './components/draft-review-panel.component';
import { ModelHealthComponent } from './components/model-health.component';
import { PracticePanelComponent } from './components/practice-panel.component';
import { ProjectRailComponent } from './components/project-rail.component';
import { SourceImportPanelComponent } from './components/source-import-panel.component';
import { WrongAnswerReviewComponent } from './components/wrong-answer-review.component';
import { OperationStore } from './stores/operation.store';
import { ProjectStore } from './stores/project.store';
import { WorkspaceFacade } from './stores/workspace.facade';

@Component({
  imports: [
    DraftReviewPanelComponent,
    ModelHealthComponent,
    PracticePanelComponent,
    ProjectRailComponent,
    SourceImportPanelComponent,
    WrongAnswerReviewComponent,
  ],
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  protected readonly title = 'Exam Prep';
  protected readonly operations = inject(OperationStore);
  protected readonly projects = inject(ProjectStore);
  private readonly workspace = inject(WorkspaceFacade);

  async ngOnInit(): Promise<void> {
    await this.workspace.loadStartupState();
  }
}
