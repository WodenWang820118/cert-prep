import { resource } from '@angular/core';
import type { HttpResourceRef } from '@angular/common/http';
import type { CertPrepGeneratedClient } from '@cert-prep/api';
import {
  CertPrepHttpResourceClient,
  type CertPrepHttpResource,
  type CertPrepResourceKey,
  type CertPrepResourceTrigger,
} from '../cert-prep-http-resource-client';

type FakeApi = object;

export function provideCertPrepHttpResourceClientFake(api: FakeApi) {
  return {
    provide: CertPrepHttpResourceClient,
    useFactory: () => createCertPrepHttpResourceClientFake(api),
  };
}

export function createCertPrepHttpResourceClientFake(
  api: FakeApi,
): CertPrepHttpResourceClient {
  const invoke = (method: keyof CertPrepGeneratedClient, ...args: unknown[]) =>
    ((api as Record<string, unknown>)[method] as (
      ...callArgs: unknown[]
    ) => Promise<unknown>)(...args);

  const items = <T>(value: unknown): T[] =>
    (value as { items: T[] }).items;
  const gated = (trigger?: CertPrepResourceTrigger): (() => boolean | undefined) =>
    () => (trigger === undefined || trigger() ? true : undefined);
  const key = (projectId: CertPrepResourceKey): (() => string | undefined) =>
    () => projectId() ?? undefined;

  return {
    projects: (trigger?: CertPrepResourceTrigger) =>
      fakeResource(gated(trigger), [], () =>
        invoke('listProjects').then((value) => items(value)),
      ),
    health: (trigger?: CertPrepResourceTrigger) =>
      fakeResource(gated(trigger), null, () => invoke('health')),
    llmHealth: (trigger?: CertPrepResourceTrigger) =>
      fakeResource(gated(trigger), null, () => invoke('llmHealth')),
    ocrHealth: (trigger?: CertPrepResourceTrigger) =>
      fakeResource(gated(trigger), null, () => invoke('ocrHealth')),
    providerSelection: (trigger?: CertPrepResourceTrigger) =>
      fakeResource(gated(trigger), null, () => invoke('llmProviderSelection')),
    runtimeRequirements: (trigger?: CertPrepResourceTrigger) =>
      fakeResource(gated(trigger), [], () =>
        invoke('runtimeRequirements').then((value) => items(value)),
      ),
    documents: (projectId: CertPrepResourceKey) =>
      fakeResource(key(projectId), [], (id) =>
        invoke('listDocuments', id).then((value) => items(value)),
      ),
    document: (projectId: CertPrepResourceKey, documentId: CertPrepResourceKey) =>
      fakeResource(
        () => {
          const project = projectId();
          const document = documentId();
          return project !== null && project !== undefined && document !== null && document !== undefined
            ? `${project}:${document}`
            : undefined;
        },
        null,
        (compoundId) => {
          const [project, document] = String(compoundId).split(':');
          return invoke('getDocument', project, document);
        },
      ),
    documentChunks: (
      projectId: CertPrepResourceKey,
      documentId: CertPrepResourceKey,
    ) =>
      fakeResource(
        () => {
          const project = projectId();
          const document = documentId();
          return project !== null && project !== undefined && document !== null && document !== undefined
            ? `${project}:${document}`
            : undefined;
        },
        [],
        (compoundId) => {
          const [project, document] = String(compoundId).split(':');
          return invoke('listDocumentChunks', project, document).then((value) =>
            items(value),
          );
        },
      ),
    questionDrafts: (projectId: CertPrepResourceKey) =>
      fakeResource(key(projectId), [], (id) =>
        invoke('listQuestionDrafts', id).then((value) => items(value)),
      ),
    activePracticeSessions: (projectId: CertPrepResourceKey) =>
      fakeResource(key(projectId), [], (id) =>
        invoke('listActivePracticeSessions', id).then((value) => items(value)),
      ),
    wrongAnswers: (projectId: CertPrepResourceKey) =>
      fakeResource(key(projectId), [], (id) =>
        invoke('listWrongAnswers', id).then((value) => items(value)),
      ),
    wrongAnswerSummary: (projectId: CertPrepResourceKey) =>
      fakeResource(key(projectId), null, (id) =>
        invoke('summarizeWrongAnswers', id),
      ),
  } as unknown as CertPrepHttpResourceClient;
}

function fakeResource<T, TParam>(
  params: () => TParam,
  defaultValue: T,
  loader: (param: Exclude<TParam, undefined>) => Promise<T>,
): CertPrepHttpResource<T> {
  return resource<T, TParam>({
    params,
    defaultValue,
    loader: ({ params: value }) =>
      loader(value as Exclude<TParam, undefined>),
  }) as unknown as HttpResourceRef<T>;
}
