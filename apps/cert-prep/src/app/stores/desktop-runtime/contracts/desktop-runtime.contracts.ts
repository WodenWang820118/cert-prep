/**
 * Normalized lifecycle buckets for the packaged Python runtime installer.
 */
export type RuntimePhase =
  | 'missing'
  | 'installed'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed';

/**
 * Current desktop backend status returned by the Tauri command layer.
 */
export interface DesktopRuntimeStatus {
  readonly kind: string;
  readonly label: string;
  readonly available: boolean;
  readonly running: boolean;
  readonly status: string;
  readonly detail: string;
  readonly unavailableReason?: string | null;
  readonly version?: string | null;
  readonly installedPath?: string | null;
  readonly baseUrl?: string | null;
  readonly token?: string | null;
  readonly jobId?: string | null;
  readonly completed?: number | null;
  readonly total?: number | null;
  readonly error?: string | null;
}

/**
 * Runtime installation job snapshot returned by the Tauri command layer.
 */
export interface DesktopRuntimeInstallation {
  readonly id: string;
  readonly kind: string;
  readonly provider: string;
  readonly model: string;
  readonly status: string;
  readonly detail: string;
  readonly completed?: number | null;
  readonly total?: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error?: string | null;
}

/**
 * Phase of the one-time runtime refresh the desktop host runs after an app
 * update: it reinstalls bundled runtimes the user had installed before.
 */
export type RuntimeUpdatePhase = 'applying' | 'succeeded' | 'failed';

/**
 * Snapshot returned by the `runtime_update_status` Tauri command. `idle`
 * snapshots (no refresh this launch) are normalized to `null`.
 */
export interface RuntimeUpdateNotice {
  readonly phase: RuntimeUpdatePhase;
  readonly runtimes: readonly string[];
  readonly completed: number;
  readonly total: number;
  readonly estimatedSeconds: number | null;
  readonly error: string | null;
}
