import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { DesktopRuntimeStore } from './stores/desktop-runtime/desktop-runtime.store';

export const requireBackendRuntimeReady: CanActivateFn = async () => {
  const desktopRuntime = inject(DesktopRuntimeStore);
  const router = inject(Router);

  if (desktopRuntime.isDesktop()) {
    await desktopRuntime.load();
  }

  if (desktopRuntime.isBackendReady()) {
    return true;
  }

  return router.parseUrl('/runtime');
};
