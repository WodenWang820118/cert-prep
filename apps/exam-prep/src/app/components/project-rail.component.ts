import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Button, ButtonDirective } from 'primeng/button';
import { Card } from 'primeng/card';
import { InputText } from 'primeng/inputtext';
import { Textarea } from 'primeng/textarea';
import { OperationStore } from '../stores/operation.store';
import { ProjectStore } from '../stores/project.store';
import { WorkspaceFacade } from '../stores/workspace.facade';

@Component({
  selector: 'app-project-rail',
  imports: [Button, ButtonDirective, Card, FormsModule, InputText, Textarea],
  template: `
    <div class="grid gap-4">
      <p-card styleClass="exam-card">
        <form class="grid gap-3" (ngSubmit)="workspace.createProject()">
          <h2 class="m-0 text-base font-bold text-color">Projects</h2>
          <div class="grid gap-1.5">
            <label class="text-sm font-semibold text-muted-color" for="projectName">
              Name
            </label>
            <input
              pInputText
              id="projectName"
              name="projectName"
              type="text"
              autocomplete="off"
              fluid
              [ngModel]="projects.projectName()"
              (ngModelChange)="projects.setProjectName($event)"
            />
          </div>
          <div class="grid gap-1.5">
            <label
              class="text-sm font-semibold text-muted-color"
              for="projectDescription"
            >
              Description
            </label>
            <textarea
              pTextarea
              id="projectDescription"
              name="projectDescription"
              rows="3"
              [autoResize]="true"
              [fluid]="true"
              [ngModel]="projects.projectDescription()"
              (ngModelChange)="projects.setProjectDescription($event)"
            ></textarea>
          </div>
          <p-button
            label="Create project"
            icon="pi pi-plus"
            type="submit"
            [fluid]="true"
            [disabled]="operations.isBusy() || projects.projectName().trim().length === 0"
          />
        </form>
      </p-card>

      <div class="grid gap-2" aria-label="Project list">
        @for (project of projects.projects(); track project.id) {
          <button
            pButton
            type="button"
            severity="secondary"
            [outlined]="true"
            class="project-select-button"
            [class.is-selected]="project.id === projects.selectedProjectId()"
            (click)="workspace.selectProject(project.id)"
          >
            <span class="grid min-w-0 gap-1">
              <strong class="truncate text-sm">{{ project.name }}</strong>
              @if (project.description) {
                <span class="truncate text-xs text-muted-color">
                  {{ project.description }}
                </span>
              }
            </span>
          </button>
        } @empty {
          <p
            class="m-0 rounded-lg border border-dashed border-surface-300 bg-surface-0 p-3 text-sm text-muted-color"
          >
            No projects yet.
          </p>
        }
      </div>
    </div>
  `,
})
export class ProjectRailComponent {
  protected readonly operations = inject(OperationStore);
  protected readonly projects = inject(ProjectStore);
  protected readonly workspace = inject(WorkspaceFacade);
}
