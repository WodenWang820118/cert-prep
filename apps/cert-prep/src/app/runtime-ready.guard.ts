import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs';
import { DesktopRuntimeStore } from './stores/desktop-runtime/desktop-runtime.store';

export const requireBackendRuntimeReady: CanActivateFn = () => {
  const desktopRuntime = inject(DesktopRuntimeStore);
  const router = inject(Router);

  if (desktopRuntime.isDesktop()) {
    return desktopRuntime.load().pipe(
      map(() =>
        desktopRuntime.isBackendReady() ? true : router.parseUrl('/runtime'),
      ),
    );
  }

  if (desktopRuntime.isBackendReady()) {
    return true;
  }

  return router.parseUrl('/runtime');
};
