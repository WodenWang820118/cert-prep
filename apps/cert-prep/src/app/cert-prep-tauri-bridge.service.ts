import { Injectable } from '@angular/core';
import { defer, from, Observable, switchMap } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class CertPrepTauriBridgeService {
  isDesktop(): boolean {
    const windowRef = globalThis as typeof globalThis & {
      window?: Window & { __TAURI_INTERNALS__?: unknown };
    };

    return (
      typeof windowRef.window !== 'undefined' &&
      '__TAURI_INTERNALS__' in windowRef.window
    );
  }

  invoke<TResult>(
    command: string,
    args?: Record<string, unknown>,
  ): Observable<TResult> {
    return defer(() => from(import('@tauri-apps/api/core'))).pipe(
      switchMap(({ invoke }) => from(invoke<TResult>(command, args))),
    );
  }
}
