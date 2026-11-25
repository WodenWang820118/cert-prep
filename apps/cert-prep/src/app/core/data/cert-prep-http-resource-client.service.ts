import {
  httpResource,
  type HttpResourceRequest,
} from '@angular/common/http';
import { inject, Injectable, Injector } from '@angular/core';
import {
  createCertPrepRequestFactory,
} from '@cert-prep/api';
import type {
  ChunkRead,
  CertPrepHttpRequest,
  SourceRead,
  HealthResponse,
  LLMHealthRead,
  LLMProviderSelectionRead,
  PracticeSessionSummaryRead,
  ProjectRead,
  QuestionRead,
  LLMRequirementRead,
  WrongAnswerRead,
  WrongAnswerSummaryRead,
} from '../domain';

import type {
  CertPrepHttpResource,
  CertPrepResourceKey,
  CertPrepResourceTrigger,
} from '../domain';

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

  providerSelection(
    trigger?: CertPrepResourceTrigger,
  ): CertPrepHttpResource<LLMProviderSelectionRead | null> {
    return this.requestResource(
      () => this.gatedRequest(trigger, () => this.requests.llmProviderSelection()),
      null,
      'llm-provider-selection',
    );
  }

  llmRequirements(
    trigger?: CertPrepResourceTrigger,
  ): CertPrepHttpResource<LLMRequirementRead[]> {
    return this.collectionResource(
      () =>
        this.gatedRequest(trigger, () => this.requests.llmRequirements()),
      'llm-requirements',
    );
  }

  sources(projectId: CertPrepResourceKey): CertPrepHttpResource<SourceRead[]> {
    return this.collectionResource(
      () => {
        const id = projectId();
        return id === undefined || id === null
          ? undefined
          : this.requests.listSources(id);
      },
      'sources',
    );
  }

  source(
    projectId: CertPrepResourceKey,
    sourceId: CertPrepResourceKey,
  ): CertPrepHttpResource<SourceRead | null> {
    return this.requestResource(
      () => {
        const project = projectId();
        const source = sourceId();
        return project === undefined || project === null || source === undefined || source === null
          ? undefined
          : this.requests.getSource(project, source);
      },
      null,
      'source',
    );
  }

  sourceChunks(
    projectId: CertPrepResourceKey,
    sourceId: CertPrepResourceKey,
  ): CertPrepHttpResource<ChunkRead[]> {
    return this.collectionResource(
      () => {
        const project = projectId();
        const source = sourceId();
        return project === undefined || project === null || source === undefined || source === null
          ? undefined
          : this.requests.listSourceChunks(project, source);
      },
      'source-chunks',
    );
  }

  questions(projectId: CertPrepResourceKey): CertPrepHttpResource<QuestionRead[]> {
    return this.collectionResource(
      () => {
        const id = projectId();
        return id === undefined || id === null
          ? undefined
          : this.requests.listQuestions(id);
      },
      'questions',
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
