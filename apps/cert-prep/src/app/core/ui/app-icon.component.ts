import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { APP_ICONS, type AppIconName } from './app-icons';

/** A decorative icon. While `busy`, it shows a spinner instead. */
@Component({
  selector: 'app-icon',
  imports: [NgIcon],
  viewProviders: [provideIcons(APP_ICONS)],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'aria-hidden': 'true',
    '[attr.data-icon]': 'shown()',
  },
  template: `<ng-icon [name]="shown()" [class.animate-spin]="busy()" />`,
  styles: `
    :host {
      display: inline-flex;
      flex-shrink: 0;
      font-size: 1rem;
      line-height: 1;
    }
  `,
})
export class AppIconComponent {
  readonly name = input.required<AppIconName>();
  readonly busy = input(false);

  protected shown(): AppIconName {
    return this.busy() ? 'lucideLoaderCircle' : this.name();
  }
}
