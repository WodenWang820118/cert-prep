import { TestBed } from '@angular/core/testing';
import type { DownloadPhase } from './contracts/health-runtime.contracts';
import { RuntimeJobViewService } from './runtime-job-view.service';

describe('RuntimeJobViewService', () => {
  let service: RuntimeJobViewService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(RuntimeJobViewService);
  });

  it('maps canonical model-download fields', () => {
    const view = service.toModelDownloadView(
      {
        id: 'job-1',
        model: 'qwen3.5:4b',
        status: 'waiting_for_user',
        phase: 'awaiting_consent',
        detail: 'Confirm the runtime terms.',
        completed: 1,
        total: 4,
        error: null,
      },
      'running',
      { currentJobId: null, modelName: null },
    );

    expect(view).toEqual({
      jobId: 'job-1',
      model: 'qwen3.5:4b',
      phase: 'waiting_for_user',
      status: 'waiting_for_user',
      progress: 25,
      message: 'Confirm the runtime terms.',
      error: null,
    });
  });

  it('ignores legacy response aliases', () => {
    const view = service.toModelDownloadView(
      {
        state: 'success',
        job_id: 'legacy-snake-id',
        jobId: 'legacy-camel-id',
        message: 'Legacy message',
        done: true,
        percent: 75,
        percentage: 80,
        downloaded_bytes: 8,
        total_bytes: 10,
      },
      'running',
      { currentJobId: 'current-job', modelName: 'qwen3.5:4b' },
    );

    expect(view.jobId).toBe('current-job');
    expect(view.phase).toBe('running');
    expect(view.status).toBe('running');
    expect(view.progress).toBeNull();
    expect(view.message).toBe('Model download is running.');
  });

  it.each([
    'waiting',
    'user_action_required',
    'complete',
    'completed',
    'done',
    'success',
    'error',
    'cancelled',
    'canceled',
  ])('does not normalize the legacy %s status', (status) => {
    const view = service.toModelDownloadView(
      { id: 'job-1', status },
      'running',
      { currentJobId: null, modelName: 'qwen3.5:4b' },
    );

    expect(view.phase).toBe('running');
  });

  it.each<[string, DownloadPhase]>([
    ['queued', 'running'],
    ['running', 'running'],
    ['waiting_for_user', 'waiting_for_user'],
    ['succeeded', 'succeeded'],
    ['failed', 'failed'],
  ])('preserves the canonical %s status', (status, phase) => {
    const view = service.toModelDownloadView(
      { id: 'job-1', status },
      'running',
      { currentJobId: null, modelName: 'qwen3.5:4b' },
    );

    expect(view.phase).toBe(phase);
  });
});
