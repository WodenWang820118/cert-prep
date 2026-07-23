import { inject, Injectable, signal } from '@angular/core';
import { defer, from, of } from 'rxjs';
import { DesktopRuntimeStore } from './desktop-runtime/desktop-runtime.store';
import { DraftReviewStore } from './draft-review/draft-review.store';
import { HealthStore } from './health/health.store';
import { OperationStore } from './operation.store';
import { PracticeStore } from './practice/practice.store';
import { ProjectStore } from './project.store';
import { SourceImportStore } from './source-import/source-import.store';
import { WrongAnswerReviewStore } from './wrong-answer-review.store';

@Injectable({ providedIn: 'root' })
export class WorkspaceFacade {
  private readonly desktopRuntime = inject(DesktopRuntimeStore);
  private readonly drafts = inject(DraftReviewStore);
  private readonly health = inject(HealthStore);
  private readonly operations = inject(OperationStore);
  private readonly practice = inject(PracticeStore);
  private readonly projects = inject(ProjectStore);
  private readonly review = inject(WrongAnswerReviewStore);
  private readonly sourceImport = inject(SourceImportStore);
  readonly hasLoadedBackendState = signal(false);

  loadStartupState(): void {
    from(this.desktopRuntime.load()).subscribe(() => {
      if (!this.desktopRuntime.isBackendReady()) {
        this.operations.status.set('Python backend runtime is required.');
        return;
      }

      if (this.hasLoadedBackendState()) {
        return;
      }

      this.operations
        .run('startup', 'Workspace ready', () =>
          defer(() => {
            this.projects.load();
            return of(undefined);
          }),
        )
        .subscribe((loaded) => {
          if (loaded === null) {
            return;
          }
          this.hasLoadedBackendState.set(true);
          this.health.load();
        });
    });
  }

  createProject(onCreated?: () => void): void {
    this.projects.createFromForm((project) => {
      this.selectProject(project.id);
      onCreated?.();
    });
  }

  selectProject(projectId: string): void {
    this.projects.select(projectId);
    this.sourceImport.reset();
    this.drafts.reset();
    this.practice.reset();
    this.review.reset();

    this.sourceImport.loadLatestDocument(projectId);
    this.drafts.load(projectId);
    this.review.load(projectId);
    this.practice.loadActiveSession(projectId);
    this.operations.status.set('Project loaded');
  }
}
