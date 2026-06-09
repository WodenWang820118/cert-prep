import { computed, inject, Injectable, signal } from '@angular/core';
import { EXAM_PREP_API, ProjectRead } from '../exam-prep-api';
import { OperationStore } from './operation.store';

@Injectable({ providedIn: 'root' })
export class ProjectStore {
  private readonly api = inject(EXAM_PREP_API);
  private readonly operations = inject(OperationStore);

  readonly projects = signal<ProjectRead[]>([]);
  readonly selectedProjectId = signal<string | null>(null);
  readonly projectName = signal('');
  readonly projectDescription = signal('');
  readonly selectedProject = computed(() => {
    const selectedId = this.selectedProjectId();
    return this.projects().find((project) => project.id === selectedId) ?? null;
  });

  async load(): Promise<void> {
    const projects = await this.api.listProjects();
    this.projects.set(projects.items);
  }

  async createFromForm(): Promise<ProjectRead | null> {
    const name = this.projectName().trim();
    if (name.length === 0) {
      this.operations.fail('Project name is required.');
      return null;
    }

    const project = await this.operations.run('project', 'Project created', () =>
      this.api.createProject({
        name,
        description: this.projectDescription().trim(),
      }),
    );
    if (project === null) {
      return null;
    }

    this.projects.update((projects) => [
      project,
      ...projects.filter((item) => item.id !== project.id),
    ]);
    this.projectName.set('');
    this.projectDescription.set('');
    return project;
  }

  select(projectId: string): void {
    this.selectedProjectId.set(projectId);
  }

  setProjectName(value: string): void {
    this.projectName.set(value);
  }

  setProjectDescription(value: string): void {
    this.projectDescription.set(value);
  }
}
