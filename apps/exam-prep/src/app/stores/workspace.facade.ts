import { inject, Injectable, signal } from '@angular/core';
import { DesktopRuntimeStore } from './desktop-runtime.store';
import { DraftReviewStore } from './draft-review.store';
import { HealthStore } from './health.store';
import { OperationStore } from './operation.store';
import { PracticeStore } from './practice.store';
import { ProjectStore } from './project.store';
import { SourceImportStore } from './source-import.store';
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

  async loadStartupState(): Promise<void> {
    await this.desktopRuntime.load();
    if (!this.desktopRuntime.isBackendReady()) {
      this.operations.status.set('Python backend runtime is required.');
      return;
    }

    if (this.hasLoadedBackendState()) {
      return;
    }

    const loaded = await this.operations.run(
      'startup',
      'Workspace ready',
      async () => {
        await this.projects.load();
      },
    );
    if (loaded === null) {
      return;
    }
    this.hasLoadedBackendState.set(true);

    const firstProject = this.projects.projects()[0];
    if (firstProject !== undefined) {
      await this.selectProject(firstProject.id);
    }
    void this.health.load().catch(() => undefined);
  }

  async createProject(): Promise<void> {
    const project = await this.projects.createFromForm();
    if (project !== null) {
      await this.selectProject(project.id);
    }
  }

  async selectProject(projectId: string): Promise<void> {
    this.projects.select(projectId);
    this.sourceImport.reset();
    this.drafts.reset();
    this.practice.reset();
    this.review.reset();

    const loaded = await this.operations.run(
      'project',
      'Project loaded',
      async () => {
        await Promise.all([
          this.sourceImport.loadLatestDocument(projectId),
          this.drafts.load(projectId),
          this.review.load(projectId),
        ]);
      },
    );
    if (loaded === null) {
      this.drafts.reset();
      this.review.reset();
    }
  }
}
