import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { CertPrepTauriBridgeService } from '../../services/cert-prep-tauri-bridge.service';

/**
 * Small boundary around Tauri globals and command invocation so the runtime
 * store can focus on state transitions instead of platform probing. Kept as a
 * separate injectable so the store's tests can replace it independently.
 */
@Injectable({ providedIn: 'root' })
export class DesktopRuntimeBridgeService {
  private readonly tauri = inject(CertPrepTauriBridgeService);

  isDesktop(): boolean {
    return this.tauri.isDesktop();
  }

  invoke<TResult>(
    command: string,
    args?: Record<string, unknown>,
  ): Observable<TResult> {
    return this.tauri.invoke<TResult>(command, args);
  }
}
