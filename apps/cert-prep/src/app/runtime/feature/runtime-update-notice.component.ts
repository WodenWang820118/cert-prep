import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { DesktopRuntimeStore } from '../data';
import { DesktopRuntimeViewService } from '../data';
import { RUNTIME_UPDATE_COPY } from '../domain';
import { AppIconComponent } from '../../core/ui';

/**
 * Shell strip for the one-time runtime refresh after an app update. In
 * the desktop shell the live region is always present, so screen readers
 * announce each phase; the browser build has no runtime updates.
 */
@Component({
  selector: 'app-runtime-update-notice',
  imports: [AppIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (desktopRuntime.isDesktop()) {
      <div role="status" aria-live="polite" aria-atomic="true">
        @if (notice(); as notice) {
          <section
            class="workbench-message-strip"
            [class.is-success]="notice.phase === 'succeeded'"
            [class.is-error]="notice.phase === 'failed'"
            data-testid="runtime-update-notice"
            [attr.data-phase]="notice.phase"
          >
            <app-icon
              [name]="
                notice.phase === 'failed'
                  ? 'lucideCircleAlert'
                  : 'lucideCircleCheck'
              "
              [busy]="notice.phase === 'applying'"
            />
            <span>{{ message() }}</span>
            @if (notice.phase === 'applying' && notice.total > 0) {
              <progress
                [attr.max]="notice.total"
                [attr.value]="notice.completed"
                [attr.aria-label]="copy.progressLabel"
              ></progress>
              @if (notice.total > 1) {
                <span>{{ copy.progress(notice.completed, notice.total) }}</span>
              }
            }
            @if (notice.phase === 'failed') {
              <button
                class="workbench-icon-button"
                type="button"
                [attr.aria-label]="copy.dismiss"
                (click)="desktopRuntime.dismissRuntimeUpdate()"
              >
                <app-icon name="lucideX" />
              </button>
            }
          </section>
        }
      </div>
    }
  `,
})
export class RuntimeUpdateNoticeComponent {
  protected readonly desktopRuntime = inject(DesktopRuntimeStore);
  private readonly view = inject(DesktopRuntimeViewService);
  protected readonly copy = RUNTIME_UPDATE_COPY;
  protected readonly notice = this.desktopRuntime.runtimeUpdate;
  protected readonly message = computed(() => {
    const notice = this.notice();
    return notice === null ? '' : this.view.runtimeUpdateMessage(notice);
  });
}
