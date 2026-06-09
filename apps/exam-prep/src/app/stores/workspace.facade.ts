import { inject, Injectable } from '@angular/core';
import { DraftReviewStore } from './draft-review.store';
import { HealthStore } from './health.store';
import { OperationStore } from './operation.store';
import { PracticeStore } from './practice.store';
import { ProjectStore } from './project.store';
import { SourceImportStore } from './source-import.store';
import { WrongAnswerReviewStore } from './wrong-answer-review.store';

@Injectable({ providedIn: 'root' })
export class WorkspaceFacade {
  private readonly drafts = inject(DraftReviewStore);
  private readonly health = inject(HealthStore);
  private readonly operations = inject(OperationStore);
  private readonly practice = inject(PracticeStore);
  private readonly projects = inject(ProjectStore);
  private readonly review = inject(WrongAnswerReviewStore);
  private readonly sourceImport = inject(SourceImportStore);

  async loadStartupState(): Promise<void> {
    const loaded = await this.operations.run('startup', 'Workspace ready', async () => {
      await Promise.all([this.health.load(), this.projects.load()]);
    });
    if (loaded === null) {
      return;
    }

    const firstProject = this.projects.projects()[0];
    if (firstProject !== undefined) {
      await this.selectProject(firstProject.id);
    }
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

    const loaded = await this.operations.run('project', 'Project loaded', async () => {
      await Promise.all([this.drafts.load(projectId), this.review.load(projectId)]);
    });
    if (loaded === null) {
      this.drafts.reset();
      this.review.reset();
    }
  }
}
