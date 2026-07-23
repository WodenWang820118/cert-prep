import { TestBed } from '@angular/core/testing';
import { DesktopRuntimeStore } from './desktop-runtime.store';

describe('DesktopRuntimeStore', () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    TestBed.configureTestingModule({});
  });

  it('treats browser development mode as backend-ready', () => {
    const store = TestBed.inject(DesktopRuntimeStore);

    store.load().subscribe();

    expect(store.isDesktop()).toBe(false);
    expect(store.isBackendReady()).toBe(true);
    expect(store.status().label).toBe('Developer backend');
  });
});
