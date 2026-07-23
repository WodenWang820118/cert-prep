import {
  httpResource,
  type HttpResourceRef,
  type HttpResourceRequest,
} from '@angular/common/http';
import { inject, Injectable, Injector } from '@angular/core';
import {
  createCertPrepRequestFactory,
  type ChunkRead,
  type CertPrepHttpRequest,
  type DocumentRead,
  type HealthResponse,
  type LLMHealthRead,
  type LLMProviderSelectionRead,
  type OCRHealthRead,
  type PracticeSessionSummaryRead,
  type ProjectRead,
  type QuestionDraftRead,
  type RuntimeRequirementRead,
  type WrongAnswerRead,
  type WrongAnswerSummaryRead,
} from '@cert-prep/api';

export type CertPrepHttpResource<T> = HttpResourceRef<T>;
export type CertPrepResourceKey = () => string | null | undefined;
export type CertPrepResourceTrigger = () => boolean;

@Injectable({ providedIn: 'root' })
export class CertPrepHttpResourceClient {
  private readonly injector = inject(Injector);
  private readonly requests = createCertPrepRequestFactory();

  projects(
    trigger?: CertPrepResourceTrigger,
  ): CertPrepHttpResource<ProjectRead[]> {
    return this.collectionResource(
      () => this.gatedRequest(trigger, () => this.requests.listProjects()),
      'projects',
    );
  }

  health(
    trigger?: CertPrepResourceTrigger,
  ): CertPrepHttpResource<HealthResponse | null> {
    return this.requestResource(
      () => this.gatedRequest(trigger, () => this.requests.health()),
      null,
      'health',
    );
  }

  llmHealth(
    trigger?: CertPrepResourceTrigger,
  ): CertPrepHttpResource<LLMHealthRead | null> {
    return this.requestResource(
      () => this.gatedRequest(trigger, () => this.requests.llmHealth()),
      null,
      'llm-health',
    );
  }

  ocrHealth(
    trigger?: CertPrepResourceTrigger,
  ): CertPrepHttpResource<OCRHealthRead | null> {
    return this.requestResource(
      () => this.gatedRequest(trigger, () => this.requests.ocrHealth()),
      null,
      'ocr-health',
    );
  }

  providerSelection(
    trigger?: CertPrepResourceTrigger,
  ): CertPrepHttpResource<LLMProviderSelectionRead | null> {
    return this.requestResource(
      () => this.gatedRequest(trigger, () => this.requests.llmProviderSelection()),
      null,
      'llm-provider-selection',
    );
  }

  runtimeRequirements(
    trigger?: CertPrepResourceTrigger,
  ): CertPrepHttpResource<RuntimeRequirementRead[]> {
    return this.collectionResource(
      () =>
        this.gatedRequest(trigger, () => this.requests.runtimeRequirements()),
      'runtime-requirements',
    );
  }

  documents(projectId: CertPrepResourceKey): CertPrepHttpResource<DocumentRead[]> {
    return this.collectionResource(
      () => {
        const id = projectId();
        return id === undefined || id === null
          ? undefined
          : this.requests.listDocuments(id);
      },
      'documents',
    );
  }

  document(
    projectId: CertPrepResourceKey,
    documentId: CertPrepResourceKey,
  ): CertPrepHttpResource<DocumentRead | null> {
    return this.requestResource(
      () => {
        const project = projectId();
        const document = documentId();
        return project === undefined || project === null || document === undefined || document === null
          ? undefined
          : this.requests.getDocument(project, document);
      },
      null,
      'document',
    );
  }

  documentChunks(
    projectId: CertPrepResourceKey,
    documentId: CertPrepResourceKey,
  ): CertPrepHttpResource<ChunkRead[]> {
    return this.collectionResource(
      () => {
        const project = projectId();
        const document = documentId();
        return project === undefined || project === null || document === undefined || document === null
          ? undefined
          : this.requests.listDocumentChunks(project, document);
      },
      'document-chunks',
    );
  }

  questionDrafts(projectId: CertPrepResourceKey): CertPrepHttpResource<QuestionDraftRead[]> {
    return this.collectionResource(
      () => {
        const id = projectId();
        return id === undefined || id === null
          ? undefined
          : this.requests.listQuestionDrafts(id);
      },
      'question-drafts',
    );
  }

  activePracticeSessions(
    projectId: CertPrepResourceKey,
  ): CertPrepHttpResource<PracticeSessionSummaryRead[]> {
    return this.collectionResource(
      () => {
        const id = projectId();
        return id === undefined || id === null
          ? undefined
          : this.requests.listActivePracticeSessions(id);
      },
      'active-practice-sessions',
    );
  }

  wrongAnswers(projectId: CertPrepResourceKey): CertPrepHttpResource<WrongAnswerRead[]> {
    return this.collectionResource(
      () => {
        const id = projectId();
        return id === undefined || id === null
          ? undefined
          : this.requests.listWrongAnswers(id);
      },
      'wrong-answers',
    );
  }

  wrongAnswerSummary(
    projectId: CertPrepResourceKey,
  ): CertPrepHttpResource<WrongAnswerSummaryRead | null> {
    return this.requestResource(
      () => {
        const id = projectId();
        return id === undefined || id === null
          ? undefined
          : this.requests.summarizeWrongAnswers(id);
      },
      null,
      'wrong-answer-summary',
    );
  }

  private collectionResource<T>(
    request: () => CertPrepHttpRequest | undefined,
    debugName: string,
  ): CertPrepHttpResource<T[]> {
    return this.requestResource(
      request,
      [],
      debugName,
      (value: unknown) => this.items<T>(value),
    );
  }

  private requestResource<T>(
    request: () => CertPrepHttpRequest | undefined,
    defaultValue: T,
    debugName: string,
    parse?: (value: unknown) => T,
  ): CertPrepHttpResource<T> {
    return httpResource<T>(
      () => {
        const generatedRequest = request();
        return generatedRequest === undefined
          ? undefined
          : this.toHttpResourceRequest(generatedRequest);
      },
      {
        defaultValue,
        debugName: `cert-prep.${debugName}`,
        injector: this.injector,
        ...(parse === undefined ? {} : { parse }),
      },
    );
  }

  private toHttpResourceRequest(request: CertPrepHttpRequest): HttpResourceRequest {
    if (request.responseType !== undefined) {
      throw new Error('Blob responses are not supported by CertPrepHttpResourceClient.');
    }

    return {
      url: request.path,
      method: request.method,
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.headers === undefined ? {} : { headers: { ...request.headers } }),
    };
  }

  private gatedRequest(
    trigger: CertPrepResourceTrigger | undefined,
    request: () => CertPrepHttpRequest,
  ): CertPrepHttpRequest | undefined {
    return trigger === undefined || trigger() ? request() : undefined;
  }

  private items<T>(value: unknown): T[] {
    if (!this.isRecord(value) || !Array.isArray(value['items'])) {
      throw new Error('The Cert Prep API returned an invalid collection response.');
    }
    return value['items'] as T[];
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
