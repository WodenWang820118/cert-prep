import { win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  collectProcessTree,
  isCertPrepResidue,
  snapshotWindowsProcesses,
  type ProcessRecord,
} from '../process-lifecycle/processes.mts';

const DEFAULT_RELEASE_ATTEMPTS = 10;
const DEFAULT_RELEASE_INTERVAL_MS = 500;

export interface OwnedProcessesReleasedProof extends Record<string, unknown> {
  readonly appPid: number;
  readonly observedAppPids: readonly number[];
  readonly observedOwnedPids: readonly number[];
  readonly finalOwnedPids: readonly number[];
  readonly stableEmptySnapshots: number;
  readonly residueCount: number;
  readonly closedAt: string;
}

export interface OwnedProcessEvidenceTrackerOptions {
  readonly baselineProcesses: readonly ProcessRecord[];
  readonly snapshotProcesses?: () => readonly ProcessRecord[];
  readonly wait?: (milliseconds: number) => Promise<unknown>;
  readonly releaseAttempts?: number;
  readonly releaseIntervalMs?: number;
}

interface ProcessIdentity {
  readonly pid: number;
  readonly key: string;
}

/**
 * Tracks each concrete packaged-app process tree across normal restarts, then
 * proves those exact process identities and any new Cert Prep/FastFlow runtime
 * processes are absent for two consecutive post-close snapshots.
 */
export class OwnedProcessEvidenceTracker {
  private readonly baselineRuntimeIdentities: ReadonlySet<string>;
  private readonly snapshotProcesses: () => readonly ProcessRecord[];
  private readonly wait: (milliseconds: number) => Promise<unknown>;
  private readonly releaseAttempts: number;
  private readonly releaseIntervalMs: number;
  private readonly observed = new Map<string, ProcessIdentity>();
  private readonly observedAppPids = new Set<number>();

  constructor({
    baselineProcesses,
    snapshotProcesses = snapshotWindowsProcesses,
    wait = delay,
    releaseAttempts = DEFAULT_RELEASE_ATTEMPTS,
    releaseIntervalMs = DEFAULT_RELEASE_INTERVAL_MS,
  }: OwnedProcessEvidenceTrackerOptions) {
    this.snapshotProcesses = snapshotProcesses;
    this.wait = wait;
    this.releaseAttempts = Math.max(2, releaseAttempts);
    this.releaseIntervalMs = Math.max(0, releaseIntervalMs);
    this.baselineRuntimeIdentities = new Set(
      baselineProcesses
        .filter(isCandidateOwnedRuntime)
        .map(processIdentity)
        .filter((identity): identity is ProcessIdentity => identity !== null)
        .map((identity) => identity.key),
    );
  }

  captureAppTree(appPid: number, expectedExecutablePath: string): number[] {
    const processes = this.snapshotProcesses();
    const root = processes.find((record) => record.pid === appPid);
    if (
      !root ||
      normalizedWindowsPath(root.executablePath) !==
        normalizedWindowsPath(expectedExecutablePath)
    ) {
      throw new Error(
        'Owned-process evidence could not bind the live app PID to the installed executable.',
      );
    }
    const tree = collectProcessTree(processes, appPid);
    if (tree.length === 0 || tree[0]?.pid !== appPid) {
      throw new Error('Owned-process evidence could not capture the packaged app tree.');
    }
    for (const record of tree) {
      const identity = processIdentity(record);
      if (!identity) {
        throw new Error(
          `Owned-process evidence could not identify process ${record.pid}.`,
        );
      }
      this.observed.set(identity.key, identity);
    }
    this.observedAppPids.add(appPid);
    return tree.map((record) => record.pid).sort((left, right) => left - right);
  }

  async proveReleased(
    finalAppPid: number,
    closedAt: string,
  ): Promise<OwnedProcessesReleasedProof> {
    if (!this.observedAppPids.has(finalAppPid) || !Number.isFinite(Date.parse(closedAt))) {
      throw new Error('Owned-process release proof is not bound to the final app close.');
    }

    let stableEmptySnapshots = 0;
    let finalOwnedPids: number[] = [];
    let residueCount = 0;
    for (let attempt = 0; attempt < this.releaseAttempts; attempt += 1) {
      const processes = this.snapshotProcesses();
      const currentIdentities = new Set(
        processes
          .map(processIdentity)
          .filter((identity): identity is ProcessIdentity => identity !== null)
          .map((identity) => identity.key),
      );
      finalOwnedPids = [...this.observed.values()]
        .filter((identity) => currentIdentities.has(identity.key))
        .map((identity) => identity.pid)
        .sort((left, right) => left - right);
      residueCount = processes.filter((record) => {
        if (!isCandidateOwnedRuntime(record)) {
          return false;
        }
        const identity = processIdentity(record);
        return !identity || !this.baselineRuntimeIdentities.has(identity.key);
      }).length;
      stableEmptySnapshots =
        finalOwnedPids.length === 0 && residueCount === 0
          ? stableEmptySnapshots + 1
          : 0;
      if (stableEmptySnapshots >= 2) {
        break;
      }
      if (attempt + 1 < this.releaseAttempts) {
        await this.wait(this.releaseIntervalMs);
      }
    }

    return {
      appPid: finalAppPid,
      observedAppPids: [...this.observedAppPids].sort((left, right) => left - right),
      observedOwnedPids: [...new Set([...this.observed.values()].map(({ pid }) => pid))]
        .sort((left, right) => left - right),
      finalOwnedPids,
      stableEmptySnapshots,
      residueCount,
      closedAt,
    };
  }
}

function isCandidateOwnedRuntime(record: ProcessRecord): boolean {
  const name = record.name.trim().toLowerCase();
  return (
    isCertPrepResidue(record) || name === 'flm.exe' || name === 'ollama.exe'
  );
}

function processIdentity(record: ProcessRecord): ProcessIdentity | null {
  const name = record.name.trim().toLowerCase();
  const creationDate = record.creationDate.trim();
  const executablePath = normalizedWindowsPath(record.executablePath);
  if (
    !Number.isSafeInteger(record.pid) ||
    record.pid < 1 ||
    !name ||
    !creationDate ||
    !executablePath
  ) {
    return null;
  }
  return {
    pid: record.pid,
    key: `${record.pid}\u0000${creationDate}\u0000${name}\u0000${executablePath}`,
  };
}

function normalizedWindowsPath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed || !win32.isAbsolute(trimmed)) {
    return null;
  }
  return win32.normalize(trimmed).toLowerCase();
}
