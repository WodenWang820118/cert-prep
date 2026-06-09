import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { OperationStore } from '../stores/operation.store';
import { ProjectStore } from '../stores/project.store';
import { WorkspaceFacade } from '../stores/workspace.facade';

@Component({
  selector: 'app-project-rail',
  imports: [FormsModule],
  template: `
    <form class="project-form" (ngSubmit)="workspace.createProject()">
      <h2>Projects</h2>
      <label>
        <span>Name</span>
        <input
          name="projectName"
          type="text"
          autocomplete="off"
          [ngModel]="projects.projectName()"
          (ngModelChange)="projects.setProjectName($event)"
        />
      </label>
      <label>
        <span>Description</span>
        <textarea
          name="projectDescription"
          rows="3"
          [ngModel]="projects.projectDescription()"
          (ngModelChange)="projects.setProjectDescription($event)"
        ></textarea>
      </label>
      <button
        class="primary-button"
        type="submit"
        [disabled]="operations.isBusy() || projects.projectName().trim().length === 0"
      >
        Create project
      </button>
    </form>

    <div class="project-list" aria-label="Project list">
      @for (project of projects.projects(); track project.id) {
        <button
          type="button"
          [class.is-selected]="project.id === projects.selectedProjectId()"
          (click)="workspace.selectProject(project.id)"
        >
          <strong>{{ project.name }}</strong>
          @if (project.description) {
            <span>{{ project.description }}</span>
          }
        </button>
      } @empty {
        <p class="empty-state">No projects yet.</p>
      }
    </div>
  `,
})
export class ProjectRailComponent {
  protected readonly operations = inject(OperationStore);
  protected readonly projects = inject(ProjectStore);
  protected readonly workspace = inject(WorkspaceFacade);
}
