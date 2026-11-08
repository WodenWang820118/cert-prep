import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { HlmButton, type ButtonVariants } from '@spartan-ng/helm/button';
import { AppIconComponent } from './app-icon.component';
import type { AppIconName } from './app-icons';

/** A labelled button with an optional icon. While `loading`, it is disabled and shows a spinner. */
@Component({
  selector: 'app-action-button',
  imports: [HlmButton, AppIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      hlmBtn
      type="button"
      [variant]="variant()"
      [disabled]="disabled() || loading()"
      (click)="pressed.emit()"
    >
      @if (icon(); as iconName) {
        <app-icon [name]="iconName" [busy]="loading()" />
      } @else if (loading()) {
        <app-icon name="lucideLoaderCircle" [busy]="true" />
      }
      {{ label() }}
    </button>
  `,
  styles: `
    :host {
      display: inline-flex;
    }
  `,
})
export class ActionButtonComponent {
  readonly label = input.required<string>();
  readonly icon = input<AppIconName>();
  readonly variant = input<ButtonVariants['variant']>('default');
  readonly disabled = input(false);
  readonly loading = input(false);
  readonly pressed = output<void>();
}
