import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { CertPrepRuntimeConfig } from '../../core/data';
import type { RuntimeUpdateNotice } from '../../stores/desktop-runtime/contracts/desktop-runtime.contracts';
import { DesktopRuntimeBridgeService } from '../../stores/desktop-runtime/desktop-runtime-bridge.service';
import { DesktopRuntimeStore } from '../../stores/desktop-runtime/desktop-runtime.store';
import { RuntimeUpdateNoticeComponent } from './runtime-update-notice.component';

describe('RuntimeUpdateNoticeComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [RuntimeUpdateNoticeComponent],
      providers: [
        {
          provide: DesktopRuntimeBridgeService,
          useValue: { isDesktop: () => true, invoke: vi.fn(() => of(null)) },
        },
        {
          provide: CertPrepRuntimeConfig,
          useValue: { invalidateBackendConfig: vi.fn() },
        },
      ],
    });
  });

  function render(notice: RuntimeUpdateNotice | null) {
    const fixture = TestBed.createComponent(RuntimeUpdateNoticeComponent);
    TestBed.inject(DesktopRuntimeStore).runtimeUpdate.set(notice);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    return {
      fixture,
      liveRegion: element.querySelector('[role="status"]') as HTMLElement,
      strip: element.querySelector('[data-testid="runtime-update-notice"]'),
    };
  }

  it('keeps an empty polite live region when there is no update', () => {
    const { liveRegion, strip } = render(null);

    expect(liveRegion).not.toBeNull();
    expect(liveRegion.getAttribute('aria-live')).toBe('polite');
    expect(liveRegion.textContent?.trim()).toBe('');
    expect(strip).toBeNull();
  });

  it('announces the update being applied with its estimate and progress', () => {
    const { liveRegion, strip } = render({
      phase: 'applying',
      runtimes: ['python_backend', 'capture_runtime'],
      completed: 1,
      total: 2,
      estimatedSeconds: 4,
      error: null,
    });

    expect(strip?.getAttribute('data-phase')).toBe('applying');
    expect(liveRegion.textContent).toContain(
      '正在套用更新：更新本機服務與辨識執行環境（約需 4 秒）',
    );
    expect(liveRegion.textContent).toContain('已完成 1/2');
    const progress = liveRegion.querySelector('progress');
    expect(progress?.getAttribute('max')).toBe('2');
    expect(progress?.getAttribute('value')).toBe('1');
    expect(progress?.getAttribute('aria-label')).toBe('更新進度');
  });

  it('announces success', () => {
    const { liveRegion, strip } = render({
      phase: 'succeeded',
      runtimes: ['capture_runtime'],
      completed: 1,
      total: 1,
      estimatedSeconds: null,
      error: null,
    });

    expect(strip?.classList.contains('is-success')).toBe(true);
    expect(liveRegion.textContent).toContain('更新已套用完成。');
    expect(liveRegion.querySelector('progress')).toBeNull();
  });

  it('announces a failure with the error and the kept runtime, and can be dismissed', () => {
    const { fixture, liveRegion, strip } = render({
      phase: 'failed',
      runtimes: ['capture_runtime'],
      completed: 1,
      total: 1,
      estimatedSeconds: null,
      error: 'Capture runtime SHA-256 mismatch.',
    });

    expect(strip?.classList.contains('is-error')).toBe(true);
    expect(liveRegion.textContent).toContain(
      '套用更新失敗：Capture runtime SHA-256 mismatch。先前的執行環境仍保留在電腦上，未被更動。',
    );
    const dismiss = liveRegion.querySelector(
      'button[aria-label="關閉更新通知"]',
    ) as HTMLButtonElement;
    dismiss.click();
    fixture.detectChanges();

    expect(
      liveRegion.querySelector('[data-testid="runtime-update-notice"]'),
    ).toBeNull();
    expect(TestBed.inject(DesktopRuntimeStore).runtimeUpdate()).toBeNull();
  });
});
