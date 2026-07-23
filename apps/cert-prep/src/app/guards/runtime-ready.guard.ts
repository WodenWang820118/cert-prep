import { inject, Injectable } from '@angular/core';
import { CanActivate, Router } from '@angular/router';
import { map } from 'rxjs';
import { DesktopRuntimeStore } from '../stores/desktop-runtime/desktop-runtime.store';

@Injectable({ providedIn: 'root' })
export class BackendRuntimeReadyGuard implements CanActivate {
  private readonly desktopRuntime = inject(DesktopRuntimeStore);
  private readonly router = inject(Router);

  canActivate() {
    if (this.desktopRuntime.isDesktop()) {
      return this.desktopRuntime.load().pipe(
        map(() =>
          this.desktopRuntime.isBackendReady()
            ? true
            : this.router.parseUrl('/runtime'),
        ),
      );
    }

    if (this.desktopRuntime.isBackendReady()) {
      return true;
    }

    return this.router.parseUrl('/runtime');
  }
}
