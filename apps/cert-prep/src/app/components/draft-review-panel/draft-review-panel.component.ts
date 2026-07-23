import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InputText } from 'primeng/inputtext';
import { Tag } from 'primeng/tag';
import { DraftReviewStore } from '../../stores/draft-review/draft-review.store';
import { OperationStore } from '../../stores/operation.store';
import { SourceImportStore } from '../../stores/source-import/source-import.store';

@Component({
  selector: 'app-draft-review-panel',
  imports: [FormsModule, InputText, Tag],
  templateUrl: './draft-review-panel.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './draft-review-panel.component.css',
})
export class DraftReviewPanelComponent {
  protected readonly drafts = inject(DraftReviewStore);
  protected readonly operations = inject(OperationStore);
  protected readonly sourceImport = inject(SourceImportStore);

  protected choiceKey(index: number): string {
    return choiceKey(index);
  }
}

function choiceKey(index: number): string {
  let value = index + 1;
  let key = '';
  while (value > 0) {
    value -= 1;
    key = String.fromCharCode(65 + (value % 26)) + key;
    value = Math.floor(value / 26);
  }
  return key;
}
