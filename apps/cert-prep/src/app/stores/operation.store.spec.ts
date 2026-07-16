import { TestBed } from '@angular/core/testing';
import { OperationStore } from './operation.store';

describe('OperationStore', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
  });

  it('tracks the active action and records the success message', async () => {
    const store = TestBed.inject(OperationStore);
    const task = vi.fn().mockResolvedValue('done');

    const resultPromise = store.run('upload', 'Upload complete', task);

    expect(store.busy()).toBe('upload');

    await expect(resultPromise).resolves.toBe('done');
    expect(task).toHaveBeenCalledTimes(1);
    expect(store.status()).toBe('Upload complete');
    expect(store.error()).toBeNull();
    expect(store.errorCode()).toBeNull();
    expect(store.busy()).toBeNull();
  });

  it('normalizes API errors and clears busy state', async () => {
    const store = TestBed.inject(OperationStore);

    const result = await store.run('upload', 'Upload complete', async () => {
      throw {
        error: {
          code: 'too_large',
          message: 'PDF is too large.',
        },
      };
    });

    expect(result).toBeNull();
    expect(store.status()).toBe('Ready');
    expect(store.error()).toBe('PDF is too large.');
    expect(store.errorCode()).toBe('too_large');
    expect(store.busy()).toBeNull();
  });

  it('derives the success message from the completed result', async () => {
    const store = TestBed.inject(OperationStore);

    const result = await store.run(
      'upload',
      (accepted: string[]) => `${accepted.length} uploads accepted`,
      async () => ['document-1', 'document-2'],
    );

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

  it('does not suppress one action failure when another action starts later', async () => {
    const store = TestBed.inject(OperationStore);
    let rejectQuestions!: (reason: unknown) => void;
    const questions = store.run(
      'questions',
      'Questions generated',
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectQuestions = reject;
        }),
    );

    await store.run('upload', 'Upload complete', async () => 'uploaded');
    expect(store.busy()).toBe('questions');
    expect(store.isBusyFor('questions')).toBe(true);
    rejectQuestions({
      error: {
        code: 'provider_unavailable',
        message: 'Reasoning provider onboarding is required.',
      },
    });
    await questions;

    expect(store.errorCode()).toBe('provider_unavailable');
    expect(store.error()).toBe('Reasoning provider onboarding is required.');
    expect(store.busy()).toBeNull();
  });
});
