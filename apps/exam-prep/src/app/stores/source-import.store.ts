import { computed, inject, Injectable, signal } from '@angular/core';
import { DocumentRead, EXAM_PREP_API } from '../exam-prep-api';
import { HealthStore } from './health.store';
import { OperationStore } from './operation.store';
import { ProjectStore } from './project.store';

@Injectable({ providedIn: 'root' })
export class SourceImportStore {
  private readonly api = inject(EXAM_PREP_API);
  private readonly health = inject(HealthStore);
  private readonly operations = inject(OperationStore);
  private readonly projects = inject(ProjectStore);

  readonly selectedFile = signal<File | null>(null);
  readonly uploadedDocument = signal<DocumentRead | null>(null);
  readonly canUpload = computed(
    () => this.projects.selectedProject() !== null && this.selectedFile() !== null,
  );
  readonly canGenerateDrafts = computed(() => {
    const document = this.uploadedDocument();
    return (
      this.projects.selectedProject() !== null &&
      document !== null &&
      document.has_text &&
      document.chunks_count > 0
    );
  });

  chooseFile(file: File | null): void {
    this.selectedFile.set(file);
    this.uploadedDocument.set(null);
  }

  reset(): void {
    this.selectedFile.set(null);
    this.uploadedDocument.set(null);
  }

  async uploadDocument(): Promise<DocumentRead | null> {
    const project = this.projects.selectedProject();
    const file = this.selectedFile();
    if (project === null || file === null) {
      this.operations.fail('Choose a project and PDF before uploading.');
      return null;
    }

    const formData = new FormData();
    formData.append('file', file, file.name);

    const document = await this.operations.run('upload', 'PDF uploaded', () =>
      this.api.uploadDocument(project.id, formData),
    );
    if (document !== null) {
      this.uploadedDocument.set(document);
    } else if (this.operations.errorCode() === 'paddle_runtime_missing') {
      await this.refreshRuntimeHealth();
      this.health.openOcrRuntimeInstallConsent();
    }
    return document;
  }

  private async refreshRuntimeHealth(): Promise<void> {
    try {
      await this.health.load();
    } catch {
      // Keep the use-time prompt available even if the health refresh failed.
    }
  }
}
