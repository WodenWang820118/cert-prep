import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { CERT_PREP_API, ProjectRead } from '../cert-prep-api';
import { CertPrepHttpResourceClient } from '../cert-prep-http-resource-client';
import { OperationStore } from './operation.store';

@Injectable({ providedIn: 'root' })
export class ProjectStore {
  private readonly api = inject(CERT_PREP_API);
  private readonly resources = inject(CertPrepHttpResourceClient);
  private readonly operations = inject(OperationStore);
  private readonly projectListRequested = signal(false);

  private readonly projectListResource = this.resources.projects(() =>
    this.projectListRequested(),
  );
  readonly projects = signal<ProjectRead[]>([]);
  private readonly projectListSync = effect(() => {
    const status = this.projectListResource.status();
    if (status === 'resolved' || status === 'local') {
      this.projects.set(this.projectListResource.value());
    }
  });

  /** Reactive project list query; mutations remain explicit command methods. */
  readonly projectsResource = this.projectListResource.asReadonly();
  readonly projectsLoading = this.projectsResource.isLoading;
  readonly projectsError = this.projectsResource.error;
  readonly selectedProjectId = signal<string | null>(null);
  readonly projectName = signal('');
  readonly projectDescription = signal('');
  readonly selectedProject = computed(() => {
    const selectedId = this.selectedProjectId();
    return this.projects().find((project) => project.id === selectedId) ?? null;
  });

  load(): void {
    if (!this.projectListRequested()) {
      this.projectListRequested.set(true);
      return;
    }
    this.projectListResource.reload();
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

    const nextProjects = [
      project,
      ...this.projects().filter((item) => item.id !== project.id),
    ];
    this.projects.set(nextProjects);
    this.projectListResource.set(nextProjects);
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
