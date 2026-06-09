import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DraftReviewStore } from '../stores/draft-review.store';
import { OperationStore } from '../stores/operation.store';
import { SourceImportStore } from '../stores/source-import.store';

@Component({
  selector: 'app-draft-review-panel',
  imports: [FormsModule],
  template: `
    <div class="panel-heading">
      <span>02</span>
      <div>
        <h2 id="drafts-heading">Cited Drafts</h2>
        <p>{{ drafts.approvedDrafts().length }} approved</p>
      </div>
    </div>

    <div class="action-row">
      <label>
        <span>Draft count</span>
        <input
          name="draftLimit"
          type="number"
          min="1"
          max="50"
          [ngModel]="drafts.draftLimit()"
          (ngModelChange)="drafts.setDraftLimit($event)"
        />
      </label>
      <button
        class="primary-button"
        type="button"
        [disabled]="operations.isBusy() || !sourceImport.canGenerateDrafts()"
        (click)="drafts.generateDrafts()"
      >
        Generate cited drafts
      </button>
    </div>

    <div class="draft-list">
      @for (draft of drafts.drafts(); track draft.id) {
        <article
          class="draft-item"
          [class.is-approved]="draft.status === 'approved'"
        >
          <div class="item-heading">
            <span>{{ draft.status }}</span>
            @if (draft.citation_page) {
              <span>Page {{ draft.citation_page }}</span>
            }
          </div>
          <h3>{{ draft.question }}</h3>
          <ol>
            @for (choice of draft.choices; track $index) {
              <li>{{ choice }}</li>
            }
          </ol>
          @if (draft.source_excerpt) {
            <blockquote>{{ draft.source_excerpt }}</blockquote>
          }
          <div class="item-actions">
            <span>Answer: {{ draft.answer ?? 'Not set' }}</span>
            @if (draft.status === 'approved') {
              <strong>Approved</strong>
            } @else if (!drafts.canApprove(draft)) {
              <strong>Needs citation</strong>
            } @else {
              <button
                class="secondary-button"
                type="button"
                [disabled]="operations.isBusy()"
                (click)="drafts.approveDraft(draft)"
              >
                Approve draft
              </button>
            }
          </div>
        </article>
      } @empty {
        <p class="empty-state">No drafts for this project.</p>
      }
    </div>
  `,
})
export class DraftReviewPanelComponent {
  protected readonly drafts = inject(DraftReviewStore);
  protected readonly operations = inject(OperationStore);
  protected readonly sourceImport = inject(SourceImportStore);
}
