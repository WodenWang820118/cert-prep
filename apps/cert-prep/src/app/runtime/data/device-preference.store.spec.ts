import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, Subject, throwError } from 'rxjs';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type {
  DevicePreferenceRead,
  DevicePreferenceUpdate,
} from '@cert-prep/api';
import { DEVICE_COPY } from '../domain';
import { DevicePreferenceStore } from './device-preference.store';
import { HealthStore } from './health.store';
import { RuntimeApiClientsService } from './runtime-api-clients.service';

describe('DevicePreferenceStore', () => {
  let store: DevicePreferenceStore;
  let runtimeApi: {
    devicePreference: ReturnType<typeof vi.fn>;
    chooseDevicePreference: ReturnType<typeof vi.fn>;
  };
  let health: {
    refresh: ReturnType<typeof vi.fn>;
    healthRefreshFinished$: Subject<void>;
    healthSnapshotLoading: ReturnType<typeof signal<boolean>>;
  };
  let callOrder: string[];
  let serverPreference: DevicePreferenceRead;

  const initialPreference: DevicePreferenceRead = {
    mode: 'auto',
    adapter_key: null,
    adapter_name: null,
    status: 'active',
    choices: [
      {
        adapter_key: 'card-1',
        name: 'RTX 4090',
        classification: 'dedicated',
        backend: 'cuda',
        selectable: true,
      },
    ],
  };

  beforeEach(() => {
    callOrder = [];
    serverPreference = initialPreference;
    runtimeApi = {
      devicePreference: vi.fn().mockImplementation(() => {
        callOrder.push('devicePreference');
        return of(serverPreference);
      }),
      chooseDevicePreference: vi
        .fn()
        .mockImplementation((body: DevicePreferenceUpdate) => {
          callOrder.push('chooseDevicePreference');
          serverPreference = { ...serverPreference, ...body };
          return of(serverPreference);
        }),
    };

    health = {
      healthRefreshFinished$: new Subject<void>(),
      healthSnapshotLoading: signal(false),
      refresh: vi.fn().mockImplementation(() => {
        callOrder.push('health.refresh');
        health.healthSnapshotLoading.set(true);
      }),
    };

    TestBed.configureTestingModule({
      providers: [
        DevicePreferenceStore,
        { provide: RuntimeApiClientsService, useValue: runtimeApi },
        { provide: HealthStore, useValue: health },
      ],
    });

    store = TestBed.inject(DevicePreferenceStore);
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  function finishHealth(): void {
    health.healthSnapshotLoading.set(false);
    health.healthRefreshFinished$.next();
  }

  it('ignores a slow read after a save, including after its follow-up read fails', () => {
    const slowRead = new Subject<DevicePreferenceRead>();
    const put = new Subject<DevicePreferenceRead>();
    runtimeApi.devicePreference.mockReturnValueOnce(slowRead);
    runtimeApi.chooseDevicePreference.mockReturnValueOnce(put);
    store.open();
    store.choose({ mode: 'cpu' });
    const saved = {
      ...initialPreference,
      mode: 'cpu',
    } satisfies DevicePreferenceRead;
    put.next(saved);
    expect(store.preference()).toEqual(saved);
    slowRead.next(initialPreference);
    expect(store.preference()).toEqual(saved);
    runtimeApi.devicePreference.mockReturnValueOnce(
      throwError(() => new Error('offline')),
    );
    finishHealth();
    slowRead.next(initialPreference);
    expect(store.preference()).toEqual(saved);
    expect(store.saving()).toBe(false);
    expect(store.error()).toBeNull();
  });

  it('applies only the newest read even when an older read resolves last', () => {
    const older = new Subject<DevicePreferenceRead>();
    const newer = new Subject<DevicePreferenceRead>();
    runtimeApi.devicePreference
      .mockReturnValueOnce(older)
      .mockReturnValueOnce(newer);
    store.open();
    store.load();
    const saved = {
      ...initialPreference,
      mode: 'cpu',
    } satisfies DevicePreferenceRead;
    newer.next(saved);
    older.next(initialPreference);
    expect(store.preference()).toEqual(saved);
  });

  it('leaves preference null when the first read fails', () => {
    runtimeApi.devicePreference.mockReturnValueOnce(
      throwError(() => new Error('offline')),
    );
    store.open();
    expect(store.preference()).toBeNull();
    expect(store.error()).toBeNull();
  });

  it('polls pending health then preference every five seconds until active', () => {
    vi.useFakeTimers();
    serverPreference = { ...initialPreference, status: 'pending' };
    store.open();
    store.open(); // Reopening must not create another timer or subscription.
    callOrder = [];
    vi.advanceTimersByTime(4999);
    expect(callOrder).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(callOrder).toEqual(['health.refresh']);
    vi.advanceTimersByTime(5000);
    expect(callOrder).toEqual(['health.refresh']);
    finishHealth();
    expect(callOrder).toEqual(['health.refresh', 'devicePreference']);
    callOrder = [];
    vi.advanceTimersByTime(5000);
    expect(callOrder).toEqual(['health.refresh']);
    serverPreference = initialPreference;
    finishHealth();
    vi.advanceTimersByTime(15000);
    expect(callOrder).toEqual(['health.refresh', 'devicePreference']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops polling and ignores health completions after close', () => {
    vi.useFakeTimers();
    serverPreference = { ...initialPreference, status: 'pending' };
    store.open();
    callOrder = [];
    store.close();
    vi.advanceTimersByTime(15000);
    finishHealth();
    store.load();
    expect(callOrder).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not read after closing during a polling health request', () => {
    vi.useFakeTimers();
    serverPreference = { ...initialPreference, status: 'pending' };
    store.open();
    vi.advanceTimersByTime(5000);
    expect(health.refresh).toHaveBeenCalledTimes(1);
    callOrder = [];
    store.close();
    finishHealth();
    vi.advanceTimersByTime(15000);
    expect(callOrder).toEqual([]);
  });

  it('does not let a read from a previous opening replace the current preference', () => {
    const oldRead = new Subject<DevicePreferenceRead>();
    runtimeApi.devicePreference.mockReturnValueOnce(oldRead);
    store.open();
    store.close();
    serverPreference = { ...initialPreference, mode: 'cpu' };
    store.open();
    oldRead.next(initialPreference);
    expect(store.preference()).toEqual(serverPreference);
  });

  it('does not poll or read during a save and resumes after a failed save', () => {
    vi.useFakeTimers();
    serverPreference = { ...initialPreference, status: 'pending' };
    const put = new Subject<DevicePreferenceRead>();
    runtimeApi.chooseDevicePreference.mockReturnValueOnce(put);
    store.open();
    store.choose({ mode: 'cpu' });
    callOrder = [];
    vi.advanceTimersByTime(15000);
    finishHealth();
    expect(callOrder).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    put.error(new Error('offline'));
    vi.advanceTimersByTime(5000);
    expect(callOrder).toEqual(['health.refresh']);
  });

  it('waits for an already running health refresh when opened', () => {
    health.healthSnapshotLoading.set(true);
    store.open();
    expect(runtimeApi.devicePreference).not.toHaveBeenCalled();
    finishHealth();
    expect(runtimeApi.devicePreference).toHaveBeenCalledTimes(1);
  });

  it('loads preference only when explicitly opened', () => {
    expect(store.preference()).toBeNull();
    expect(runtimeApi.devicePreference).not.toHaveBeenCalled();

    store.open();

    expect(runtimeApi.devicePreference).toHaveBeenCalledTimes(1);
    expect(store.preference()).toEqual(initialPreference);
    expect(store.error()).toBeNull();
  });

  it('keeps confirmed preference after an HTTP load failure', () => {
    store.open();
    runtimeApi.devicePreference.mockReturnValue(
      throwError(() => new Error('offline')),
    );
    expect(() => store.load()).not.toThrow();
    expect(store.preference()).toEqual(initialPreference);
  });

  it('catches synchronous load failures from an incomplete API fake', () => {
    runtimeApi.devicePreference.mockImplementation(() => {
      throw new TypeError('this.api.llmDevicePreference is not a function');
    });
    expect(() => store.open()).not.toThrow();
    expect(store.preference()).toBeNull();
  });

  it('keeps saving busy until PUT resolves and ignores duplicate choices', () => {
    store.open();
    const response = new Subject<DevicePreferenceRead>();
    runtimeApi.chooseDevicePreference.mockReturnValue(response);
    store.choose({ mode: 'cpu' });
    expect(store.saving()).toBe(true);
    store.choose({ mode: 'auto' });
    expect(runtimeApi.chooseDevicePreference).toHaveBeenCalledTimes(1);
    expect(health.refresh).not.toHaveBeenCalled();
    response.error(new Error('offline'));
    expect(store.saving()).toBe(false);
    expect(store.preference()).toEqual(initialPreference);
  });

  it('saves choice with PUT, then reloads health and preference in order', () => {
    store.open();
    callOrder = [];

    const update: DevicePreferenceUpdate = { mode: 'cpu' };
    store.choose(update);

    expect(callOrder).toEqual(['chooseDevicePreference', 'health.refresh']);
    finishHealth();

    expect(runtimeApi.chooseDevicePreference).toHaveBeenCalledWith(update);
    expect(callOrder).toEqual([
      'chooseDevicePreference',
      'health.refresh',
      'devicePreference',
    ]);
    expect(store.preference()?.mode).toBe('cpu');
    expect(store.saving()).toBe(false);
    expect(store.error()).toBeNull();
  });

  it('restores previous selection and sets error on failed save', () => {
    store.open();
    const previous = store.preference();

    runtimeApi.chooseDevicePreference.mockReturnValue(
      throwError(() => ({
        status: 500,
        error: { message: 'Failed to access database' },
      })),
    );

    store.choose({ mode: 'cpu' });

    expect(store.preference()).toEqual(previous);
    expect(store.saving()).toBe(false);
    expect(store.error()).toBe(
      DEVICE_COPY.errors.saveFailed('Failed to access database'),
    );
  });

  it('handles 422 unknown_device by showing specific message and reloading preference', () => {
    store.open();
    callOrder = [];

    runtimeApi.chooseDevicePreference.mockImplementation(() => {
      callOrder.push('chooseDevicePreference');
      return throwError(() => ({
        status: 422,
        error: { code: 'unknown_device', message: 'adapter not recognized' },
      }));
    });

    store.choose({ mode: 'adapter', adapter_key: 'stale-key' });

    expect(store.saving()).toBe(false);
    expect(store.error()).toBe(DEVICE_COPY.errors.unknownDevice);
    expect(callOrder).toEqual(['chooseDevicePreference', 'devicePreference']);
  });

  it('survives closing one of two consumers: reload and polling continue until second close', () => {
    vi.useFakeTimers();
    serverPreference = {
      ...initialPreference,
      status: 'pending',
    };
    callOrder = [];

    // Open twice
    store.open();
    store.open();

    expect(callOrder).toEqual(['devicePreference']);
    callOrder = [];

    // Close once (openCount 2 -> 1)
    store.close();

    // A health completion still reloads preference
    finishHealth();
    expect(callOrder).toEqual(['devicePreference']);
    callOrder = [];

    // Pending polling continues after 5s
    vi.advanceTimersByTime(5000);
    expect(health.refresh).toHaveBeenCalledTimes(1);
    finishHealth();
    expect(callOrder).toEqual(['health.refresh', 'devicePreference']);
    callOrder = [];

    // Close second time (openCount 1 -> 0)
    store.close();

    // Now health completion does NOT reload preference
    finishHealth();
    expect(callOrder).toEqual([]);

    // Polling does NOT continue
    health.refresh.mockClear();
    vi.advanceTimersByTime(10000);
    expect(health.refresh).not.toHaveBeenCalled();
  });
});
