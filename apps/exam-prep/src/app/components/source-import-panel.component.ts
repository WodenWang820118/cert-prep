import { Component, inject } from '@angular/core';
import { OperationStore } from '../stores/operation.store';
import { ProjectStore } from '../stores/project.store';
import { SourceImportStore } from '../stores/source-import.store';

@Component({
  selector: 'app-source-import-panel',
  imports: [],
  template: `
    <div class="panel-heading">
      <span>01</span>
      <div>
        <h2 id="source-heading">Source PDF</h2>
        <p>{{ projects.selectedProject()?.name }}</p>
      </div>
    </div>

    <div class="upload-row">
      <label class="file-picker">
        <span>PDF file</span>
        <input
          type="file"
          accept="application/pdf"
          (change)="chooseFile($event)"
        />
      </label>
      <button
        class="primary-button"
        type="button"
        [disabled]="operations.isBusy() || !sourceImport.canUpload()"
        (click)="sourceImport.uploadDocument()"
      >
        Upload PDF
      </button>
    </div>

    @if (sourceImport.uploadedDocument(); as document) {
      <dl class="document-facts">
        <div>
          <dt>File</dt>
          <dd>{{ document.filename }}</dd>
        </div>
        <div>
          <dt>Pages</dt>
          <dd>{{ document.page_count }}</dd>
        </div>
        <div>
          <dt>Text chunks</dt>
          <dd>{{ document.chunks_count }}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{{ document.status }}</dd>
        </div>
      </dl>
    }
  `,
})
export class SourceImportPanelComponent {
  protected readonly operations = inject(OperationStore);
  protected readonly projects = inject(ProjectStore);
  protected readonly sourceImport = inject(SourceImportStore);

  protected chooseFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.sourceImport.chooseFile(input.files?.item(0) ?? null);
  }
}
