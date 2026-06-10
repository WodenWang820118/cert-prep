import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Button } from 'primeng/button';
import { Card } from 'primeng/card';
import { InputText } from 'primeng/inputtext';
import { Tag } from 'primeng/tag';
import { DraftReviewStore } from '../stores/draft-review.store';
import { OperationStore } from '../stores/operation.store';
import { SourceImportStore } from '../stores/source-import.store';

@Component({
  selector: 'app-draft-review-panel',
  imports: [Button, Card, FormsModule, InputText, Tag],
  template: `
    <p-card styleClass="exam-card">
      <div class="grid gap-4">
        <div
          class="grid gap-3 md:grid-cols-[2.25rem_minmax(0,1fr)_auto] md:items-start"
        >
          <span
            class="grid h-9 w-9 place-items-center rounded-md border border-primary-200 bg-primary-50 text-sm font-bold text-primary"
          >
            02
          </span>
          <div class="min-w-0">
            <h2 id="drafts-heading" class="m-0 text-base font-bold text-color">
              Mock Exam Items
            </h2>
            <p class="m-0 mt-1 text-sm text-muted-color">
              {{ drafts.approvedDrafts().length }} approved
            </p>
          </div>
          <p-tag
            [value]="drafts.drafts().length + ' items'"
            severity="secondary"
            [rounded]="true"
          />
        </div>

        <div class="grid gap-3 md:grid-cols-[10rem_auto] md:items-end">
          <label class="grid gap-1.5 text-sm font-semibold text-muted-color">
            <span>Draft count</span>
            <input
              pInputText
              name="draftLimit"
              type="number"
              min="1"
              max="50"
              [ngModel]="drafts.draftLimit()"
              (ngModelChange)="drafts.setDraftLimit($event)"
            />
          </label>
          <p-button
            label="Regenerate mock exam"
            icon="pi pi-sparkles"
            type="button"
            [disabled]="operations.isBusy() || !sourceImport.canGenerateDrafts()"
            (onClick)="drafts.generateDrafts()"
          />
        </div>

        <div class="grid gap-3">
          @for (draft of drafts.drafts(); track draft.id) {
            <article
              class="grid gap-3 rounded-lg border p-3"
              [class.border-primary-300]="draft.status === 'approved'"
              [class.border-surface-200]="draft.status !== 'approved'"
              [class.bg-highlight]="draft.status === 'approved'"
              [class.bg-surface-0]="draft.status !== 'approved'"
            >
              <div class="flex flex-wrap items-center justify-between gap-2">
                <p-tag
                  [value]="draft.status"
                  [severity]="draft.status === 'approved' ? 'success' : 'warn'"
                  [rounded]="true"
                />
                @if (draft.citation_page) {
                  <span class="text-sm font-semibold text-muted-color">
                    Page {{ draft.citation_page }}
                  </span>
                }
                <p-tag
                  [value]="draft.answer_key_source"
                  severity="secondary"
                  [rounded]="true"
                />
              </div>
              <h3 class="m-0 text-base font-semibold leading-6 text-color">
                {{ draft.question }}
              </h3>
              <ol class="m-0 grid gap-2 pl-5 text-sm sm:grid-cols-2">
                @for (choice of draft.choices; track $index) {
                  <li class="rounded-md bg-surface-50 px-2 py-1 text-color">
                    {{ choice }}
                  </li>
                }
              </ol>
              @if (draft.source_excerpt) {
                <blockquote
                  class="border-l-4 border-primary-300 bg-primary-50 px-3 py-2 text-sm leading-6 text-color"
                >
                  {{ draft.source_excerpt }}
                </blockquote>
              }
              <div class="flex flex-wrap items-center justify-between gap-3">
                <span class="text-sm text-muted-color">
                  Answer: {{ draft.answer ?? 'Not set' }}
                </span>
                @if (draft.status === 'approved') {
                  <p-tag value="Approved" severity="success" [rounded]="true" />
                } @else if (!drafts.canApprove(draft)) {
                  <p-tag value="Needs citation" severity="danger" [rounded]="true" />
                } @else {
                  <p-button
                    label="Approve draft"
                    icon="pi pi-check"
                    severity="secondary"
                    [outlined]="true"
                    type="button"
                    [disabled]="operations.isBusy()"
                    (onClick)="drafts.approveDraft(draft)"
                  />
                }
              </div>
            </article>
          } @empty {
            <p
              class="m-0 rounded-lg border border-dashed border-surface-300 bg-surface-0 p-3 text-sm text-muted-color"
            >
              No mock exam items for this project.
            </p>
          }
        </div>
      </div>
    </p-card>
  `,
})
export class DraftReviewPanelComponent {
  protected readonly drafts = inject(DraftReviewStore);
  protected readonly operations = inject(OperationStore);
  protected readonly sourceImport = inject(SourceImportStore);
}
