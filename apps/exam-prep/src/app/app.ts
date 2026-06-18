import { Component, inject, OnInit, signal } from '@angular/core';
import { ButtonDirective } from 'primeng/button';
import { Message } from 'primeng/message';
import { DraftReviewPanelComponent } from './components/draft-review-panel.component';
import { ModelHealthComponent } from './components/model-health.component';
import { PracticePanelComponent } from './components/practice-panel.component';
import { ProjectRailComponent } from './components/project-rail.component';
import { SourceImportPanelComponent } from './components/source-import-panel.component';
import { WrongAnswerReviewComponent } from './components/wrong-answer-review.component';
import { OperationStore } from './stores/operation.store';
import { ProjectStore } from './stores/project.store';
import { DesktopRuntimeStore } from './stores/desktop-runtime.store';
import { WorkspaceFacade } from './stores/workspace.facade';

type StudyMode = 'build' | 'full_exam' | 'random_quiz' | 'review';

interface StudyModeOption {
  readonly id: StudyMode;
  readonly label: string;
  readonly icon: string;
}

@Component({
  imports: [
    ButtonDirective,
    DraftReviewPanelComponent,
    Message,
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
  protected readonly activeMode = signal<StudyMode>('build');
  protected readonly studyModes: readonly StudyModeOption[] = [
    { id: 'build', label: 'Build', icon: 'pi pi-wrench' },
    { id: 'full_exam', label: 'Full Exam', icon: 'pi pi-file-check' },
    { id: 'random_quiz', label: 'Random Quiz', icon: 'pi pi-sync' },
    { id: 'review', label: 'Review', icon: 'pi pi-history' },
  ];
  protected readonly desktopRuntime = inject(DesktopRuntimeStore);
  protected readonly operations = inject(OperationStore);
  protected readonly projects = inject(ProjectStore);
  private readonly workspace = inject(WorkspaceFacade);

  async ngOnInit(): Promise<void> {
    await this.workspace.loadStartupState();
  }

  protected selectMode(mode: StudyMode): void {
    this.activeMode.set(mode);
  }
}
