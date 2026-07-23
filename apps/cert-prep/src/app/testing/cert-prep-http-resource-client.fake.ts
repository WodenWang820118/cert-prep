import { computed, effect, signal, untracked } from '@angular/core';
import type { HttpResourceRef } from '@angular/common/http';
import type { CertPrepGeneratedClient } from '../contracts/api.contracts';
import { from, map, Observable, of, Subscription } from 'rxjs';
import type { ObservableInput } from 'rxjs';
import { CertPrepHttpResourceClient } from '../cert-prep-http-resource-client';
import type {
  CertPrepHttpResource,
  CertPrepResourceKey,
  CertPrepResourceTrigger,
} from '../contracts/http-resource.contracts';

type FakeApi = object;

export function provideCertPrepHttpResourceClientFake(api: FakeApi) {
  return { provide: CertPrepHttpResourceClient, useFactory: () => createCertPrepHttpResourceClientFake(api) };
}

export function createCertPrepHttpResourceClientFake(api: FakeApi): CertPrepHttpResourceClient {
  const invoke = (method: keyof CertPrepGeneratedClient, ...args: unknown[]) => {
    const candidate = (api as Record<string, unknown>)[method];
    if (typeof candidate !== 'function') {
      return method.toString().startsWith('list')
        ? from([{ items: [] }])
        : from([null]);
    }
    const result = (candidate as (...callArgs: unknown[]) => ObservableInput<unknown>)(...args);
    if (result === undefined) {
      return method.toString().startsWith('list')
        ? of({ items: [] })
        : of(null);
    }
    return from(result);
  };
  const items = <T>(value: unknown): T[] => (value as { items: T[] }).items;
  const gated = (trigger?: CertPrepResourceTrigger): (() => boolean | undefined) => () => trigger === undefined || trigger() ? true : undefined;
  const key = (projectId: CertPrepResourceKey): (() => string | undefined) => () => projectId() ?? undefined;
  return {
    projects: (trigger: CertPrepResourceTrigger | undefined) => fakeResource(gated(trigger), [], () => invoke('listProjects').pipe(mapItems(items))),
    health: (trigger: CertPrepResourceTrigger | undefined) => fakeResource(gated(trigger), null, () => invoke('health')),
    llmHealth: (trigger: CertPrepResourceTrigger | undefined) => fakeResource(gated(trigger), null, () => invoke('llmHealth')),
    ocrHealth: (trigger: CertPrepResourceTrigger | undefined) => fakeResource(gated(trigger), null, () => invoke('ocrHealth')),
    providerSelection: (trigger: CertPrepResourceTrigger | undefined) => fakeResource(gated(trigger), null, () => invoke('llmProviderSelection')),
    runtimeRequirements: (trigger: CertPrepResourceTrigger | undefined) => fakeResource(gated(trigger), [], () => invoke('runtimeRequirements').pipe(mapItems(items))),
    documents: (projectId: CertPrepResourceKey) => fakeResource(key(projectId), [], (id) => invoke('listDocuments', id).pipe(mapItems(items))),
    document: (projectId: CertPrepResourceKey, documentId: CertPrepResourceKey) => fakeResource(() => {
      const project = projectId(); const document = documentId();
      return project !== null && project !== undefined && document !== null && document !== undefined ? `${project}:${document}` : undefined;
    }, null, (compoundId) => { const [project, document] = String(compoundId).split(':'); return invoke('getDocument', project, document); }),
    documentChunks: (projectId: CertPrepResourceKey, documentId: CertPrepResourceKey) => fakeResource(() => {
      const project = projectId(); const document = documentId();
      return project !== null && project !== undefined && document !== null && document !== undefined ? `${project}:${document}` : undefined;
    }, [], (compoundId) => { const [project, document] = String(compoundId).split(':'); return invoke('listDocumentChunks', project, document).pipe(mapItems(items)); }),
    questionDrafts: (projectId: CertPrepResourceKey) => fakeResource(key(projectId), [], (id) => invoke('listQuestionDrafts', id).pipe(mapItems(items))),
    activePracticeSessions: (projectId: CertPrepResourceKey) => fakeResource(key(projectId), [], (id) => invoke('listActivePracticeSessions', id).pipe(mapItems(items))),
    wrongAnswers: (projectId: CertPrepResourceKey) => fakeResource(key(projectId), [], (id) => invoke('listWrongAnswers', id).pipe(mapItems(items))),
    wrongAnswerSummary: (projectId: CertPrepResourceKey) => fakeResource(key(projectId), null, (id) => invoke('summarizeWrongAnswers', id)),
  } as unknown as CertPrepHttpResourceClient;
}

function mapItems<T>(items: (value: unknown) => T[]) {
  return map((value: unknown) => items(value));
}

function fakeResource<T, TParam>(params: () => TParam, defaultValue: T, loader: (param: Exclude<TParam, undefined>) => Observable<T>): CertPrepHttpResource<T> {
  const value = signal(defaultValue);
  const status = signal<'idle' | 'loading' | 'reloading' | 'resolved' | 'local' | 'error'>('idle');
  const error = signal<unknown>(null);
  const revision = signal(0);
  let subscription: Subscription | null = null;
  const run = (param: TParam): void => {
    subscription?.unsubscribe();
    if (param === undefined) { status.set('idle'); return; }
    status.set(untracked(value) === defaultValue ? 'loading' : 'reloading');
    subscription = loader(param as Exclude<TParam, undefined>).subscribe({ next: (next) => { value.set(next); status.set('resolved'); error.set(null); }, error: (reason) => { error.set(reason); status.set('error'); } });
  };
  effect(() => { revision(); run(params()); });
  return {
    value,
    status,
    error,
    isLoading: computed(() => status() === 'loading' || status() === 'reloading'),
    reload: () => revision.update((current) => current + 1),
    set: (next: T) => { value.set(next); status.set('local'); },
    asReadonly: () => ({ value, status, error, isLoading: computed(() => status() === 'loading' || status() === 'reloading'), reload: () => revision.update((current) => current + 1), set: (next: T) => value.set(next) }) as unknown as HttpResourceRef<T>,
  } as unknown as CertPrepHttpResource<T>;
}
