import { Injectable } from '@angular/core';

/**
 * Small boundary around Tauri globals and command invocation so the runtime
 * store can focus on state transitions instead of platform probing.
 */
@Injectable({ providedIn: 'root' })
export class DesktopRuntimeBridgeService {
  isDesktop(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }

  async invoke<TResult>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<TResult> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<TResult>(command, args);
  }
}
