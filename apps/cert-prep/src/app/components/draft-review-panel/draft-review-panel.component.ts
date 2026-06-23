import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Button } from 'primeng/button';
import { Card } from 'primeng/card';
import { InputText } from 'primeng/inputtext';
import { Tag } from 'primeng/tag';
import { DraftReviewStore } from '../../stores/draft-review/draft-review.store';
import { OperationStore } from '../../stores/operation.store';
import { SourceImportStore } from '../../stores/source-import/source-import.store';

@Component({
  selector: 'app-draft-review-panel',
  imports: [Button, Card, FormsModule, InputText, Tag],
  templateUrl: './draft-review-panel.component.html',
  styleUrl: './draft-review-panel.component.css',
})
export class DraftReviewPanelComponent {
  protected readonly drafts = inject(DraftReviewStore);
  protected readonly operations = inject(OperationStore);
  protected readonly sourceImport = inject(SourceImportStore);
}
