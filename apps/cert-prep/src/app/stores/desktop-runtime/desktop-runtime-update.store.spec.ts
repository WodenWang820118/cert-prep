import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { CertPrepRuntimeConfig } from '../../services/cert-prep-api.service';
import {
  RUNTIME_UPDATE_POLL_INTERVAL_MS,
  RUNTIME_UPDATE_SUCCESS_VISIBLE_MS,
} from './constants/desktop-runtime.constants';
import { DesktopRuntimeBridgeService } from './desktop-runtime-bridge.service';
import { DesktopRuntimeViewService } from './desktop-runtime-view.service';
import { DesktopRuntimeStore } from './desktop-runtime.store';

describe('DesktopRuntimeStore runtime update notice', () => {
  let desktop = true;
  let invoke: ReturnType<typeof vi.fn>;
  let updates: unknown[];

  beforeEach(() => {
    vi.useFakeTimers();
    desktop = true;
    updates = [];
    invoke = vi.fn((command: string) => {
      if (command === 'runtime_update_status') {
        return of(updates.length > 1 ? updates.shift() : updates[0]);
      }
      return of({ kind: command, status: 'installed' });
    });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: DesktopRuntimeBridgeService,
          useValue: { isDesktop: () => desktop, invoke },
        },
        {
          provide: CertPrepRuntimeConfig,
          useValue: { invalidateBackendConfig: vi.fn() },
        },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls while the update applies, then shows success briefly and reloads runtime status', () => {
    updates = [
      notice('applying', { completed: 0, estimatedSeconds: 8 }),
      notice('applying', { completed: 1, estimatedSeconds: 3 }),
      notice('succeeded', { completed: 2, estimatedSeconds: null }),
    ];
    const store = TestBed.inject(DesktopRuntimeStore);

    store.watchRuntimeUpdate();
    expect(store.runtimeUpdate()?.phase).toBe('applying');
    expect(store.isRuntimeUpdateApplying()).toBe(true);

    vi.advanceTimersByTime(RUNTIME_UPDATE_POLL_INTERVAL_MS);
    expect(store.runtimeUpdate()?.completed).toBe(1);

    vi.advanceTimersByTime(RUNTIME_UPDATE_POLL_INTERVAL_MS);
    expect(store.runtimeUpdate()?.phase).toBe('succeeded');
    expect(invoke).toHaveBeenCalledWith('desktop_runtime_status');
    expect(invoke).toHaveBeenCalledWith('capture_runtime_status');

    vi.advanceTimersByTime(RUNTIME_UPDATE_SUCCESS_VISIBLE_MS);
    expect(store.runtimeUpdate()).toBeNull();
    const polls = invoke.mock.calls.filter(
      ([command]) => command === 'runtime_update_status',
    );
    expect(polls).toHaveLength(3);
  });

  it('keeps a failure visible until it is dismissed', () => {
    updates = [
      notice('failed', { error: 'Capture runtime SHA-256 mismatch.' }),
    ];
    const store = TestBed.inject(DesktopRuntimeStore);

    store.watchRuntimeUpdate();
    vi.advanceTimersByTime(RUNTIME_UPDATE_SUCCESS_VISIBLE_MS * 2);

    expect(store.runtimeUpdate()?.phase).toBe('failed');
    expect(store.runtimeUpdate()?.error).toBe(
      'Capture runtime SHA-256 mismatch.',
    );
    store.dismissRuntimeUpdate();
    expect(store.runtimeUpdate()).toBeNull();
  });

  it('shows nothing when no update ran, the read fails, or outside the desktop shell', () => {
    updates = [{ phase: 'idle', runtimes: [], completed: 0, total: 0 }];
    const store = TestBed.inject(DesktopRuntimeStore);
    store.watchRuntimeUpdate();
    expect(store.runtimeUpdate()).toBeNull();

    invoke.mockReturnValueOnce(throwError(() => new Error('bridge down')));
    store.watchRuntimeUpdate();
    expect(store.runtimeUpdate()).toBeNull();

    vi.advanceTimersByTime(RUNTIME_UPDATE_POLL_INTERVAL_MS * 4);
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === 'runtime_update_status',
      ),
    ).toHaveLength(2);
  });

  it('does not query the host outside the desktop shell', () => {
    desktop = false;
    const store = TestBed.inject(DesktopRuntimeStore);

    store.watchRuntimeUpdate();

    expect(invoke).not.toHaveBeenCalled();
    expect(store.runtimeUpdate()).toBeNull();
  });
});

describe('DesktopRuntimeViewService runtime update copy', () => {
  const view = new DesktopRuntimeViewService();

  const message = (value: unknown): string => {
    const parsed = view.runtimeUpdateNotice(value);
    if (parsed === null) {
      throw new Error('expected a runtime update notice');
    }
    return view.runtimeUpdateMessage(parsed);
  };

  it('names each runtime being updated with the estimate', () => {
    expect(message(notice('applying', { estimatedSeconds: 8 }))).toBe(
      '正在套用更新：更新本機服務與辨識執行環境（約需 8 秒）',
    );
    expect(
      message({
        ...notice('applying', { estimatedSeconds: null }),
        runtimes: ['capture_runtime'],
        total: 1,
      }),
    ).toBe('正在套用更新：更新辨識執行環境');
  });

  it('words success and failure, keeping the previous runtime explicit', () => {
    expect(message(notice('succeeded'))).toBe('更新已套用完成。');
    expect(
      message(notice('failed', { error: 'Capture runtime SHA-256 mismatch.' })),
    ).toBe(
      '套用更新失敗：Capture runtime SHA-256 mismatch。先前的執行環境仍保留在電腦上，未被更動。',
    );
  });

  it('rejects idle or malformed snapshots', () => {
    expect(view.runtimeUpdateNotice({ phase: 'idle' })).toBeNull();
    expect(view.runtimeUpdateNotice({ kind: 'python_backend' })).toBeNull();
    expect(view.runtimeUpdateNotice(null)).toBeNull();
  });
});

function notice(
  phase: 'applying' | 'succeeded' | 'failed',
  overrides: {
    completed?: number;
    estimatedSeconds?: number | null;
    error?: string | null;
  } = {},
) {
  return {
    phase,
    runtimes: ['python_backend', 'capture_runtime'],
    completed: overrides.completed ?? (phase === 'applying' ? 0 : 2),
    total: 2,
    estimatedSeconds: overrides.estimatedSeconds ?? null,
    error: overrides.error ?? null,
  };
}
