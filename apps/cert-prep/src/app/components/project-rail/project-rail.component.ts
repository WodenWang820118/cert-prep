import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InputText } from 'primeng/inputtext';
import { Textarea } from 'primeng/textarea';
import { OperationStore } from '../../stores/operation.store';
import { ProjectStore } from '../../stores/project.store';
import { WorkspaceFacade } from '../../stores/workspace.facade';

@Component({
  selector: 'app-project-rail',
  imports: [FormsModule, InputText, Textarea],
  templateUrl: './project-rail.component.html',
  styleUrl: './project-rail.component.css',
})
export class ProjectRailComponent {
  protected readonly operations = inject(OperationStore);
  protected readonly projects = inject(ProjectStore);
  protected readonly workspace = inject(WorkspaceFacade);
  protected readonly createFormOpen = signal(false);

  protected openCreateForm(): void {
    this.createFormOpen.set(true);
  }

  protected async createProject(): Promise<void> {
    await this.workspace.createProject();
    if (!this.operations.error()) {
      this.createFormOpen.set(false);
    }
  }
}
