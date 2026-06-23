import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Button } from 'primeng/button';
import { Card } from 'primeng/card';
import { InputText } from 'primeng/inputtext';
import { Textarea } from 'primeng/textarea';
import { OperationStore } from '../../stores/operation.store';
import { ProjectStore } from '../../stores/project.store';
import { WorkspaceFacade } from '../../stores/workspace.facade';

@Component({
  selector: 'app-project-rail',
  imports: [Button, Card, FormsModule, InputText, Textarea],
  templateUrl: './project-rail.component.html',
  styleUrl: './project-rail.component.css',
})
export class ProjectRailComponent {
  protected readonly operations = inject(OperationStore);
  protected readonly projects = inject(ProjectStore);
  protected readonly workspace = inject(WorkspaceFacade);
}
