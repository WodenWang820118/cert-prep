import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Button } from 'primeng/button';
import { Card } from 'primeng/card';
import { InputText } from 'primeng/inputtext';
import { Tag } from 'primeng/tag';
import { DraftReviewStore } from '../stores/draft-review/draft-review.store';
import { OperationStore } from '../stores/operation.store';
import { SourceImportStore } from '../stores/source-import/source-import.store';

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

        <div
          class="grid gap-3 md:grid-cols-[10rem_minmax(0,1fr)] md:items-end"
        >
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
          <div class="flex flex-wrap gap-2">
            <p-button
              label="Generate deterministic drafts"
              icon="pi pi-list-check"
              severity="secondary"
              [outlined]="true"
              type="button"
              [disabled]="operations.isBusyFor('drafts') || !sourceImport.canGenerateDrafts()"
              [loading]="operations.isBusyFor('drafts')"
              (onClick)="drafts.generateDrafts('deterministic_only')"
            />
            <p-button
              label="Enrich with reasoning"
              icon="pi pi-sparkles"
              type="button"
              [disabled]="operations.isBusyFor('drafts') || !sourceImport.canGenerateDrafts()"
              [loading]="operations.isBusyFor('drafts')"
              (onClick)="drafts.generateDrafts('hybrid_reasoning')"
            />
          </div>
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
              @if (drafts.isEditing(draft)) {
                <div class="grid gap-3">
                  <label class="grid gap-1.5 text-sm font-semibold text-muted-color">
                    <span>Question</span>
                    <input
                      pInputText
                      [name]="'question-' + draft.id"
                      [ngModel]="drafts.draftEdit(draft).question"
                      (ngModelChange)="drafts.setEditQuestion(draft.id, $event)"
                    />
                  </label>

                  <fieldset class="m-0 grid gap-2 border-0 p-0">
                    <legend class="pb-1 text-sm font-bold text-muted-color">
                      Choices
                    </legend>
                    @for (choice of drafts.draftEdit(draft).choices; track $index) {
                      <div
                        class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2"
                      >
                        <input
                          pInputText
                          [name]="'choice-' + draft.id + '-' + $index"
                          [ngModel]="choice"
                          (ngModelChange)="drafts.setEditChoice(draft.id, $index, $event)"
                        />
                        <p-button
                          icon="pi pi-times"
                          severity="secondary"
                          [outlined]="true"
                          size="small"
                          type="button"
                          [disabled]="drafts.draftEdit(draft).choices.length <= 2"
                          (onClick)="drafts.removeEditChoice(draft.id, $index)"
                        />
                      </div>
                    }
                    <p-button
                      label="Add choice"
                      icon="pi pi-plus"
                      severity="secondary"
                      [outlined]="true"
                      size="small"
                      type="button"
                      (onClick)="drafts.addEditChoice(draft.id)"
                    />
                  </fieldset>

                  <label class="grid gap-1.5 text-sm font-semibold text-muted-color">
                    <span>Answer</span>
                    <select
                      class="h-11 rounded-md border border-surface-300 bg-surface-0 px-3 text-sm font-semibold text-color"
                      [ngModel]="drafts.draftEdit(draft).answer"
                      (ngModelChange)="drafts.setEditAnswer(draft.id, $event)"
                    >
                      <option value="">Select answer</option>
                      @for (choice of drafts.draftEdit(draft).choices; track $index) {
                        <option [value]="choice">{{ choice || 'Choice ' + ($index + 1) }}</option>
                      }
                    </select>
                  </label>

                  <label class="grid gap-1.5 text-sm font-semibold text-muted-color">
                    <span>Rationale</span>
                    <textarea
                      class="min-h-24 resize-y rounded-md border border-surface-300 bg-surface-0 p-3 text-sm leading-6 text-color"
                      [name]="'rationale-' + draft.id"
                      [ngModel]="drafts.draftEdit(draft).rationale"
                      (ngModelChange)="drafts.setEditRationale(draft.id, $event)"
                    ></textarea>
                  </label>
                </div>
              } @else {
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
                @if (draft.rationale) {
                  <p class="m-0 text-sm leading-6 text-color">
                    {{ draft.rationale }}
                  </p>
                }
              }

              <div class="grid gap-2 rounded-md border border-surface-200 bg-surface-50 p-3">
                <div class="flex flex-wrap items-center gap-2 text-sm font-semibold text-muted-color">
                  <span>Page {{ draft.citation_page ?? 'n/a' }}</span>
                  <span>Chunk {{ draft.chunk_id ?? 'n/a' }}</span>
                </div>
                @if (draft.source_excerpt) {
                  <blockquote
                    class="m-0 border-l-4 border-primary-300 bg-primary-50 px-3 py-2 text-sm leading-6 text-color"
                  >
                    {{ draft.source_excerpt }}
                  </blockquote>
                } @else {
                  <p class="m-0 text-sm text-muted-color">No source excerpt.</p>
                }
              </div>

              <div class="flex flex-wrap items-center justify-between gap-3">
                <span class="text-sm text-muted-color">
                  Answer:
                  {{
                    drafts.isEditing(draft)
                      ? drafts.draftEdit(draft).answer || 'Not set'
                      : draft.answer ?? 'Not set'
                  }}
                </span>
                @if (draft.status === 'approved') {
                  <p-tag value="Approved" severity="success" [rounded]="true" />
                } @else {
                  <p-tag
                    [value]="drafts.approvalBlockerText(draft)"
                    [severity]="drafts.canApprove(draft) ? 'success' : 'danger'"
                    [rounded]="true"
                  />
                }
              </div>

              @if (draft.status !== 'approved') {
                <div class="flex flex-wrap justify-end gap-2">
                  @if (drafts.isEditing(draft)) {
                    <p-button
                      label="Cancel"
                      severity="secondary"
                      [outlined]="true"
                      type="button"
                      [disabled]="operations.isBusyFor(['saveDraft', 'approve'])"
                      (onClick)="drafts.cancelEdit(draft)"
                    />
                    <p-button
                      label="Save"
                      icon="pi pi-save"
                      severity="secondary"
                      [outlined]="true"
                      type="button"
                      [disabled]="operations.isBusyFor(['saveDraft', 'approve'])"
                      [loading]="operations.isBusyFor('saveDraft')"
                      (onClick)="drafts.saveDraft(draft)"
                    />
                    <p-button
                      label="Save & approve"
                      icon="pi pi-check"
                      type="button"
                      [disabled]="
                        operations.isBusyFor(['saveDraft', 'approve']) ||
                        !drafts.canApprove(draft)
                      "
                      [loading]="operations.isBusyFor(['saveDraft', 'approve'])"
                      (onClick)="drafts.saveAndApproveDraft(draft)"
                    />
                  } @else {
                    <p-button
                      label="Edit"
                      icon="pi pi-pencil"
                      severity="secondary"
                      [outlined]="true"
                      type="button"
                      [disabled]="operations.isBusyFor(['saveDraft', 'approve'])"
                      (onClick)="drafts.startEdit(draft)"
                    />
                    <p-button
                      label="Approve"
                      icon="pi pi-check"
                      severity="secondary"
                      [outlined]="true"
                      type="button"
                      [disabled]="operations.isBusyFor('approve') || !drafts.canApprove(draft)"
                      [loading]="operations.isBusyFor('approve')"
                      (onClick)="drafts.approveDraft(draft)"
                    />
                  }
                </div>
              }
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
