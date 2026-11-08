import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { OperationStore } from './operation.store';

describe('OperationStore', () => {
  beforeEach(() => TestBed.configureTestingModule({}));

  it('tracks the active action and records the success message', () => {
    const store = TestBed.inject(OperationStore);
    const task = vi.fn(() => of('done'));
    let result: string | null = null;
    store.run('upload', 'Upload complete', task).subscribe((value) => result = value);
    TestBed.tick();
    expect(result).toBe('done');
    expect(task).toHaveBeenCalledTimes(1);
    expect(store.status()).toBe('Upload complete');
    expect(store.error()).toBeNull();
    expect(store.errorCode()).toBeNull();
    expect(store.busy()).toBeNull();
  });

  it('normalizes API errors and clears busy state', () => {
    const store = TestBed.inject(OperationStore);
    store.run('upload', 'Upload complete', () => throwError(() => ({ error: { code: 'too_large', message: 'PDF is too large.' } }))).subscribe();
    TestBed.tick();
    expect(store.status()).toBe('Ready');
    expect(store.error()).toBe('PDF is too large.');
    expect(store.errorCode()).toBe('too_large');
    expect(store.busy()).toBeNull();
  });

  it('derives the success message from the completed result', () => {
    const store = TestBed.inject(OperationStore);
    let result: readonly string[] | null = null;
    store.run('upload', (accepted: string[]) => `${accepted.length} uploads accepted`, () => of(['document-1', 'document-2'])).subscribe((value) => result = value);
    TestBed.tick();
    expect(result).toEqual(['document-1', 'document-2']);
    expect(store.status()).toBe('2 uploads accepted');
  });

  it('supports direct failure messages and action-specific busy checks', () => {
    const store = TestBed.inject(OperationStore);
    store.busy.set('runtime');
    store.fail('Runtime setup failed.');
    expect(store.error()).toBe('Runtime setup failed.');
    expect(store.isBusyFor('runtime')).toBe(true);
    expect(store.isBusyFor(['health', 'runtime'])).toBe(true);
    expect(store.isBusyFor('project')).toBe(false);
  });

  it('keeps a pending action isolated while a later action completes', () => {
    const store = TestBed.inject(OperationStore);
    const questions = new Subject<string>();
    const errors: unknown[] = [];
    store.run('questions', 'Questions generated', () => questions).subscribe((value) => errors.push(value));
    store.run('upload', 'Upload complete', () => of('uploaded')).subscribe();
    TestBed.tick();
    expect(store.busy()).toBe('questions');
    expect(store.isBusyFor('questions')).toBe(true);
    questions.error({ error: { code: 'provider_unavailable', message: 'Reasoning provider onboarding is required.' } });
    TestBed.tick();
    expect(errors).toEqual([null]);
    expect(store.errorCode()).toBe('provider_unavailable');
    expect(store.error()).toBe('Reasoning provider onboarding is required.');
    expect(store.busy()).toBeNull();
  });
});
