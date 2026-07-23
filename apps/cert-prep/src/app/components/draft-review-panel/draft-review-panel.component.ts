import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InputText } from 'primeng/inputtext';
import { Tag } from 'primeng/tag';
import { DraftReviewStore } from '../../stores/draft-review/draft-review.store';
import { OperationStore } from '../../stores/operation.store';
import { SourceImportStore } from '../../stores/source-import/source-import.store';
import { ChoiceKeyService } from '../../services/choice-key.service';

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
  private readonly choiceKeys = inject(ChoiceKeyService);

  protected choiceKey(index: number): string {
    return this.choiceKeys.key(index);
  }
}
