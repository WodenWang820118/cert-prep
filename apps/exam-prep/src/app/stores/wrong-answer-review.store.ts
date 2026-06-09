import { inject, Injectable, signal } from '@angular/core';
import { EXAM_PREP_API, WrongAnswerRead } from '../exam-prep-api';
import { OperationStore } from './operation.store';
import { ProjectStore } from './project.store';

@Injectable({ providedIn: 'root' })
export class WrongAnswerReviewStore {
  private readonly api = inject(EXAM_PREP_API);
  private readonly operations = inject(OperationStore);
  private readonly projects = inject(ProjectStore);

  readonly wrongAnswers = signal<WrongAnswerRead[]>([]);

  async load(projectId: string): Promise<void> {
    const wrongAnswers = await this.api.listWrongAnswers(projectId);
    this.wrongAnswers.set(wrongAnswers.items);
  }

  reset(): void {
    this.wrongAnswers.set([]);
  }

  async refresh(): Promise<void> {
    const project = this.projects.selectedProject();
    if (project === null) {
      this.operations.fail('Select a project before refreshing review.');
      return;
    }

    const wrongAnswers = await this.operations.run(
      'review',
      'Review refreshed',
      () => this.api.listWrongAnswers(project.id),
    );
    if (wrongAnswers !== null) {
      this.wrongAnswers.set(wrongAnswers.items);
    }
  }
}
