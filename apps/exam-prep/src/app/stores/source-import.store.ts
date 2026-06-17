import { computed, inject, Injectable, signal } from '@angular/core';
import { ChunkRead, DocumentRead, EXAM_PREP_API } from '../exam-prep-api';
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
  readonly chunks = signal<ChunkRead[]>([]);
  readonly previewChunks = computed(() => this.chunks().slice(0, 12));
  readonly hiddenChunkCount = computed(() =>
    Math.max(0, this.chunks().length - this.previewChunks().length),
  );
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
    this.chunks.set([]);
  }

  reset(): void {
    this.selectedFile.set(null);
    this.uploadedDocument.set(null);
    this.chunks.set([]);
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
      await this.loadDocumentChunks(project.id, document.id);
    } else if (this.operations.errorCode() === 'paddle_runtime_missing') {
      await this.refreshRuntimeHealth();
      this.health.openOcrRuntimeInstallConsent();
    }
    return document;
  }

  async loadLatestDocument(projectId: string): Promise<void> {
    const documents = await this.api.listDocuments(projectId);
    const document = documents.items[0] ?? null;
    this.uploadedDocument.set(document);
    if (document === null) {
      this.chunks.set([]);
      return;
    }
    await this.loadDocumentChunks(projectId, document.id);
  }

  private async loadDocumentChunks(projectId: string, documentId: string): Promise<void> {
    try {
      const chunks = await this.api.listDocumentChunks(projectId, documentId);
      this.chunks.set(chunks.items);
    } catch {
      this.chunks.set([]);
    }
  }

  private async refreshRuntimeHealth(): Promise<void> {
    try {
      await this.health.load();
    } catch {
      // Keep the use-time prompt available even if the health refresh failed.
    }
  }
}
