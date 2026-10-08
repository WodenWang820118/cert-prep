import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { OperationStore } from '../../stores/operation.store';
import { ProjectStore } from '../../stores/project.store';
import { WorkspaceFacade } from '../../stores/workspace.facade';
import { AppIconComponent } from '../ui/app-icon.component';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmTextarea } from '@spartan-ng/helm/textarea';

@Component({
  selector: 'app-project-rail',
  imports: [FormsModule, AppIconComponent, HlmInput, HlmTextarea],
  templateUrl: './project-rail.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
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

  protected createProject(): void {
    this.workspace.createProject(() => this.createFormOpen.set(false));
  }
}
