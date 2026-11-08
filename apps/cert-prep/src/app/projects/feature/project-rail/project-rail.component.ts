import { Component, inject, output, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { OperationStore } from '../../../core/data';
import { ProjectStore } from '../../data';
import { AppIconComponent } from '../../../core/ui';
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
  protected readonly createFormOpen = signal(false);
  /**
   * The project the user picked, by clicking it or by creating it. The shell
   * handles it (the workspace facade resets and reloads the other contexts),
   * so this upstream context does not depend on its downstream contexts.
   */
  readonly projectSelected = output<string>();

  protected openCreateForm(): void {
    this.createFormOpen.set(true);
  }

  protected createProject(): void {
    this.projects.createFromForm((project) => {
      this.projectSelected.emit(project.id);
      this.createFormOpen.set(false);
    });
  }
}
