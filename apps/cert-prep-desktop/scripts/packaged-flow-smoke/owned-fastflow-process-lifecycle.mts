import { win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  collectProcessTree,
  snapshotWindowsProcessesAsync,
  type ProcessRecord,
} from '../process-lifecycle/processes.mts';
import type {
  OwnedProcessEvidence,
  ResourcesReleasedAtEndSnapshot,
  SmokeRunState,
} from './types.mts';

const FASTFLOW_PROCESS_NAME = 'flm.exe';
const RELEASE_SNAPSHOT_ATTEMPTS = 10;
const RELEASE_SNAPSHOT_INTERVAL_MS = 1_000;
const OWNED_PROCESS_OBSERVATION_INTERVAL_MS = 1_000;
const MAX_CREATION_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const SNAPSHOT_FAILURE_CODE = 'owned_fastflow_process_snapshot_failed_closed';
const RELEASE_FAILURE_CODE = 'owned_fastflow_process_release_not_proven';

interface ProcessIdentity {
  readonly key: string;
  readonly pid: number;
  readonly name: string;
  readonly creationDate: string;
  readonly creationEpochMs: number;
  readonly executablePath: string;
}

interface OwnedFastFlowProcessTrackerOptions {
  readonly baselineProcesses: readonly ProcessRecord[];
  readonly snapshotProcesses?: () => Promise<ProcessRecord[]>;
  readonly delayForSnapshot?: (milliseconds: number) => Promise<unknown>;
  readonly now?: () => Date;
  readonly releaseSnapshotAttempts?: number;
  readonly releaseSnapshotIntervalMs?: number;
  readonly platform?: NodeJS.Platform;
}

/**
 * Records only FastFlow processes observed as descendants of the launched app.
 * It never terminates processes; shutdown remains owned by the app/backend tree.
 */
export class OwnedFastFlowProcessTracker {
  private readonly baselineIdentities: ReadonlySet<string>;
  private readonly observedIdentities = new Map<string, ProcessIdentity>();
  private readonly snapshotProcesses: () => Promise<ProcessRecord[]>;
  private readonly delayForSnapshot: (milliseconds: number) => Promise<unknown>;
  private readonly now: () => Date;
  private readonly releaseSnapshotAttempts: number;
  private readonly releaseSnapshotIntervalMs: number;
  private captureFailed: boolean;
  private releaseProvenBeforeClose = false;
  private preCloseCapturedAt: string | null = null;
  private preCloseStableEmptySnapshots = 0;
  private activeAppRoot: ProcessIdentity | null = null;
  private trustedFastFlowExecutablePath: string | null = null;
  private observationTimer: NodeJS.Timeout | null = null;
  private observationInFlight: Promise<void> | null = null;
  private releaseProofInFlight: Promise<boolean> | null = null;
  private releaseProofRunning = false;
  private observationStopping = false;

  constructor({
    baselineProcesses,
    snapshotProcesses = snapshotWindowsProcessesAsync,
    delayForSnapshot = delay,
    now = () => new Date(),
    releaseSnapshotAttempts = RELEASE_SNAPSHOT_ATTEMPTS,
    releaseSnapshotIntervalMs = RELEASE_SNAPSHOT_INTERVAL_MS,
    platform = process.platform,
  }: OwnedFastFlowProcessTrackerOptions) {
    this.snapshotProcesses = snapshotProcesses;
    this.delayForSnapshot = delayForSnapshot;
    this.now = now;
    this.releaseSnapshotAttempts = Math.max(2, releaseSnapshotAttempts);
    this.releaseSnapshotIntervalMs = Math.max(0, releaseSnapshotIntervalMs);

    const baselineFastFlowProcesses = baselineProcesses.filter(
      isFastFlowProcess,
    );
    const baselineIdentities = baselineFastFlowProcesses
      .map((process) => this.processIdentity(process))
      .filter((identity): identity is ProcessIdentity => identity !== null);
    this.baselineIdentities = new Set(
      baselineIdentities.map((identity) => identity.key),
    );
    this.captureFailed =
      platform !== 'win32' ||
      !validProcessTable(baselineProcesses) ||
      baselineIdentities.length !== baselineFastFlowProcesses.length;
  }

  async startObservingAppTree(
    appPid: number,
    expectedExecutablePath: string,
    trustedFastFlowExecutablePath: string | null,
  ): Promise<boolean> {
    if (this.captureFailed || this.observationTimer || !validPid(appPid)) {
      this.captureFailed = true;
      return false;
    }

    const expectedPath = normalizedLocalExecutablePath(expectedExecutablePath);
    const trustedFastFlowPath = trustedFastFlowExecutablePath
      ? normalizedLocalExecutablePath(trustedFastFlowExecutablePath)
      : null;
    if (
      !expectedPath ||
      (trustedFastFlowExecutablePath !== null &&
        (!trustedFastFlowPath ||
          win32.basename(trustedFastFlowPath) !== FASTFLOW_PROCESS_NAME))
    ) {
      this.captureFailed = true;
      return false;
    }

    const processes = await this.captureSnapshot();
    const appRoot = processes
      ? this.processIdentity(processes.find((record) => record.pid === appPid))
      : null;
    if (!appRoot || appRoot.executablePath !== expectedPath) {
      this.captureFailed = true;
      return false;
    }

    this.activeAppRoot = appRoot;
    this.trustedFastFlowExecutablePath = trustedFastFlowPath;
    this.observationStopping = false;
    this.resetPreCloseProof();
    this.recordAppTreeProcesses(appPid, processes ?? []);
    this.observationTimer = setInterval(
      () => this.queueObservation(appPid),
      OWNED_PROCESS_OBSERVATION_INTERVAL_MS,
    );
    this.observationTimer.unref();
    return !this.captureFailed;
  }

  async observeAppTree(appPid: number): Promise<boolean> {
    try {
      const processes = await this.captureSnapshot();
      if (!processes) {
        return false;
      }
      this.recordAppTreeProcesses(appPid, processes);
      return !this.captureFailed;
    } catch {
      this.captureFailed = true;
      return false;
    }
  }

  async stopObservingAppTree(): Promise<void> {
    this.observationStopping = true;
    if (this.observationTimer) {
      clearInterval(this.observationTimer);
      this.observationTimer = null;
    }
    await Promise.all([
      this.observationInFlight,
      this.releaseProofInFlight,
    ]);
    this.observationInFlight = null;
  }

  hasCaptureFailure(): boolean {
    return this.captureFailed;
  }

  preCloseEvidence(): ResourcesReleasedAtEndSnapshot {
    return {
      captured_at: this.preCloseCapturedAt ?? this.now().toISOString(),
      released: this.releaseProvenBeforeClose && !this.captureFailed,
      pre_close_captured_at: this.preCloseCapturedAt,
      pre_close_release_proven: this.releaseProvenBeforeClose,
      pre_close_stable_empty_snapshots: this.preCloseStableEmptySnapshots,
      stable_empty_snapshots: 0,
      observed_owned_processes: publicProcessEvidence(
        this.observedIdentities.values(),
      ),
      alive_owned_processes: [],
    };
  }

  proveReleasedBeforeClose(appPid: number): Promise<boolean> {
    if (this.observationStopping) {
      this.captureFailed = true;
      return Promise.resolve(false);
    }
    if (this.releaseProofInFlight) {
      return this.releaseProofInFlight;
    }
    const proof = this.runReleaseProof(appPid).catch(() => {
      this.captureFailed = true;
      return false;
    });
    this.releaseProofInFlight = proof;
    void proof.then(() => this.clearReleaseProof(proof));
    return proof;
  }

  private async runReleaseProof(appPid: number): Promise<boolean> {
    if (!this.activeAppRoot || this.activeAppRoot.pid !== appPid) {
      this.captureFailed = true;
      return false;
    }
    this.releaseProofRunning = true;
    try {
      await this.observationInFlight;
      this.resetPreCloseProof();

      for (let attempt = 0; attempt < this.releaseSnapshotAttempts; attempt += 1) {
        const processes = await this.captureSnapshot();
        if (!processes) {
          return false;
        }
        this.recordAppTreeProcesses(appPid, processes);
        const alive = this.aliveOwnedProcesses(processes);
        this.preCloseStableEmptySnapshots =
          alive.length === 0 ? this.preCloseStableEmptySnapshots + 1 : 0;
        if (this.preCloseStableEmptySnapshots >= 2) {
          this.releaseProvenBeforeClose = !this.captureFailed;
          this.preCloseCapturedAt = this.now().toISOString();
          return this.releaseProvenBeforeClose;
        }
        if (attempt + 1 < this.releaseSnapshotAttempts) {
          await this.delayForSnapshot(this.releaseSnapshotIntervalMs);
        }
      }
      return false;
    } finally {
      this.releaseProofRunning = false;
    }
  }

  async finalize(): Promise<ResourcesReleasedAtEndSnapshot> {
    await this.stopObservingAppTree();
    let stableEmptySnapshots = 0;
    let alive = [...this.observedIdentities.values()];

    for (let attempt = 0; attempt < this.releaseSnapshotAttempts; attempt += 1) {
      const processes = await this.captureSnapshot();
      if (!processes) {
        stableEmptySnapshots = 0;
        alive = [...this.observedIdentities.values()];
        break;
      }
      this.recordPostCloseFastFlowProcesses(processes);
      alive = this.aliveOwnedProcesses(processes);
      stableEmptySnapshots = alive.length === 0 ? stableEmptySnapshots + 1 : 0;
      if (stableEmptySnapshots >= 2) {
        break;
      }
      if (attempt + 1 < this.releaseSnapshotAttempts) {
        await this.delayForSnapshot(this.releaseSnapshotIntervalMs);
      }
    }

    return {
      captured_at: this.now().toISOString(),
      released:
        !this.captureFailed &&
        this.releaseProvenBeforeClose &&
        stableEmptySnapshots >= 2 &&
        alive.length === 0,
      pre_close_captured_at: this.preCloseCapturedAt,
      pre_close_release_proven: this.releaseProvenBeforeClose,
      pre_close_stable_empty_snapshots: this.preCloseStableEmptySnapshots,
      stable_empty_snapshots: stableEmptySnapshots,
      observed_owned_processes: publicProcessEvidence(
        this.observedIdentities.values(),
      ),
      alive_owned_processes: publicProcessEvidence(alive),
    };
  }

  private queueObservation(appPid: number): void {
    if (
      this.observationStopping ||
      this.releaseProofRunning ||
      this.observationInFlight
    ) {
      return;
    }
    const observation = this.observeAppTree(appPid)
      .then(() => undefined)
      .catch(() => {
        this.captureFailed = true;
      });
    this.observationInFlight = observation;
    void observation.then(() => {
      if (this.observationInFlight === observation) {
        this.observationInFlight = null;
      }
    });
  }

  private clearReleaseProof(proof: Promise<boolean>): void {
    if (this.releaseProofInFlight === proof) {
      this.releaseProofInFlight = null;
    }
  }

  private async captureSnapshot(): Promise<ProcessRecord[] | null> {
    try {
      const processes = await this.snapshotProcesses();
      if (!validProcessTable(processes)) {
        this.captureFailed = true;
        return null;
      }
      return processes;
    } catch {
      this.captureFailed = true;
      return null;
    }
  }

  private aliveOwnedProcesses(
    processes: readonly ProcessRecord[],
  ): ProcessIdentity[] {
    const byPid = new Map(processes.map((process) => [process.pid, process]));
    const alive: ProcessIdentity[] = [];

    for (const observed of this.observedIdentities.values()) {
      const current = byPid.get(observed.pid);
      if (!current) {
        continue;
      }
      const currentCreationDate = normalizedCreationDate(current.creationDate);
      if (!currentCreationDate) {
        this.captureFailed = true;
        alive.push(observed);
        continue;
      }
      if (currentCreationDate.token !== observed.creationDate) {
        continue;
      }
      const currentIdentity = this.processIdentity(current);
      if (!currentIdentity || currentIdentity.key !== observed.key) {
        this.captureFailed = true;
        alive.push(observed);
        continue;
      }
      alive.push(observed);
    }
    return alive;
  }

  private recordAppTreeProcesses(
    appPid: number,
    processes: readonly ProcessRecord[],
  ): void {
    const root = processes.find((process) => process.pid === appPid);
    const currentRoot = this.processIdentity(root);
    if (
      !this.activeAppRoot ||
      !currentRoot ||
      currentRoot.key !== this.activeAppRoot.key
    ) {
      this.captureFailed = true;
      return;
    }

    const byPid = new Map(processes.map((process) => [process.pid, process]));
    const candidates = collectProcessTree(processes, appPid).filter(
      isFastFlowProcess,
    );
    for (const candidate of candidates) {
      const identity = this.processIdentity(candidate);
      if (
        !identity ||
        !this.trustedFastFlowExecutablePath ||
        identity.executablePath !== this.trustedFastFlowExecutablePath ||
        !hasValidCreationChain(
          candidate,
          byPid,
          this.activeAppRoot,
          this.maximumCreationEpochMs(),
        )
      ) {
        this.captureFailed = true;
        continue;
      }
      if (
        !this.baselineIdentities.has(identity.key) &&
        !this.observedIdentities.has(identity.key)
      ) {
        this.observedIdentities.set(identity.key, identity);
        this.resetPreCloseProof();
      }
    }
  }

  private recordPostCloseFastFlowProcesses(
    processes: readonly ProcessRecord[],
  ): void {
    if (!this.activeAppRoot) {
      this.captureFailed = true;
      return;
    }
    for (const candidate of processes.filter(isFastFlowProcess)) {
      const identity = this.processIdentity(candidate);
      if (!identity) {
        this.captureFailed = true;
        continue;
      }
      if (
        this.baselineIdentities.has(identity.key) ||
        identity.creationEpochMs < this.activeAppRoot.creationEpochMs
      ) {
        continue;
      }
      if (
        this.trustedFastFlowExecutablePath &&
        identity.executablePath !== this.trustedFastFlowExecutablePath
      ) {
        this.captureFailed = true;
        continue;
      }
      if (!this.observedIdentities.has(identity.key)) {
        this.observedIdentities.set(identity.key, identity);
        this.resetPreCloseProof();
      }
    }
  }

  private processIdentity(process: ProcessRecord | undefined): ProcessIdentity | null {
    return processIdentity(process, this.maximumCreationEpochMs());
  }

  private maximumCreationEpochMs(): number {
    return this.now().getTime() + MAX_CREATION_CLOCK_SKEW_MS;
  }

  private resetPreCloseProof(): void {
    this.releaseProvenBeforeClose = false;
    this.preCloseCapturedAt = null;
    this.preCloseStableEmptySnapshots = 0;
  }
}

export function initializeOwnedFastFlowProcessTracker(run: SmokeRunState): void {
  run.ownedFastFlowProcesses = new OwnedFastFlowProcessTracker({
    baselineProcesses: run.processBaseline.all,
  });
}

export async function startOwnedFastFlowProcessObservation(
  run: SmokeRunState,
): Promise<void> {
  const tracker = run.ownedFastFlowProcesses;
  const appPid = run.app?.pid;
  const effectiveProvider =
    run.metrics.generation_readiness_at_start?.provider_selection
      ?.effective_provider;
  if (
    !tracker ||
    !appPid ||
    (effectiveProvider === 'fastflowlm' &&
      !run.trustedFastFlowExecutablePath) ||
    !(await tracker.startObservingAppTree(
      appPid,
      run.options.exePath,
      run.trustedFastFlowExecutablePath,
    ))
  ) {
    recordErrorOnce(run, SNAPSHOT_FAILURE_CODE);
  }
}

export async function observeOwnedFastFlowProcesses(
  run: SmokeRunState,
): Promise<void> {
  const appPid = run.app?.pid;
  if (!run.ownedFastFlowProcesses || !appPid) {
    return;
  }
  if (!(await run.ownedFastFlowProcesses.observeAppTree(appPid))) {
    recordErrorOnce(run, SNAPSHOT_FAILURE_CODE);
  }
}

export async function stopOwnedFastFlowProcessObservation(
  run: SmokeRunState,
): Promise<void> {
  await run.ownedFastFlowProcesses?.stopObservingAppTree();
}

export async function proveOwnedFastFlowReleaseBeforeClose(
  run: SmokeRunState,
): Promise<void> {
  const tracker = run.ownedFastFlowProcesses;
  const appPid = run.app?.pid;
  if (!tracker || !appPid || !(await tracker.proveReleasedBeforeClose(appPid))) {
    recordErrorOnce(run, RELEASE_FAILURE_CODE);
    throw new Error(RELEASE_FAILURE_CODE);
  }
  run.metrics.resources_released_at_end = tracker.preCloseEvidence();
}

export async function finalizeOwnedFastFlowProcessEvidence(
  run: SmokeRunState,
): Promise<void> {
  const tracker = run.ownedFastFlowProcesses;
  const preCloseEvidence = run.metrics.resources_released_at_end;
  const snapshot = tracker
    ? await tracker.finalize()
    : unavailableReleaseSnapshot();
  if (tracker?.hasCaptureFailure()) {
    recordErrorOnce(run, SNAPSHOT_FAILURE_CODE);
  }
  if (
    preCloseEvidence?.pre_close_release_proven !== true ||
    preCloseEvidence.pre_close_stable_empty_snapshots < 2 ||
    run.metrics.final_close?.gracefulExited !== true
  ) {
    snapshot.released = false;
  }
  run.metrics.resources_released_at_end = snapshot;
  if (
    !snapshot.released &&
    (run.options.waitForStreamingComplete || run.options.productionSummary)
  ) {
    recordErrorOnce(run, RELEASE_FAILURE_CODE);
  }
}

function processIdentity(
  process: ProcessRecord | undefined,
  maximumCreationEpochMs: number,
): ProcessIdentity | null {
  if (!process || !validPid(process.pid)) {
    return null;
  }
  const creationDate = normalizedCreationDate(process.creationDate);
  const executablePath = normalizedLocalExecutablePath(process.executablePath);
  const name = process.name.trim().toLowerCase();
  if (
    !creationDate ||
    creationDate.epochMs > maximumCreationEpochMs ||
    !executablePath ||
    !name ||
    win32.basename(executablePath).toLowerCase() !== name
  ) {
    return null;
  }
  return {
    key: `${process.pid}\u0000${creationDate.token}\u0000${name}\u0000${executablePath}`,
    pid: process.pid,
    name,
    creationDate: creationDate.token,
    creationEpochMs: creationDate.epochMs,
    executablePath,
  };
}

function normalizedCreationDate(
  value: string,
): { token: string; epochMs: number } | null {
  const trimmed = value.trim();
  const powershellDate = trimmed.match(
    /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/,
  );
  const strictIsoDate =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/;
  const epochMs = powershellDate
    ? Number(powershellDate[1])
    : strictIsoDate.test(trimmed)
      ? Date.parse(trimmed)
      : Number.NaN;
  if (!Number.isSafeInteger(epochMs) || epochMs < 0) {
    return null;
  }
  return { token: String(epochMs), epochMs };
}

function normalizedLocalExecutablePath(value: string): string | null {
  const normalized = win32.normalize(value.trim());
  return /^[a-z]:\\/i.test(normalized) ? normalized.toLowerCase() : null;
}

function hasValidCreationChain(
  candidate: ProcessRecord,
  byPid: ReadonlyMap<number, ProcessRecord>,
  appRoot: ProcessIdentity,
  maximumCreationEpochMs: number,
): boolean {
  let current = candidate;
  const seen = new Set<number>();
  while (current.pid !== appRoot.pid) {
    if (seen.has(current.pid)) {
      return false;
    }
    seen.add(current.pid);
    const childCreation = normalizedCreationDate(current.creationDate);
    const parent = byPid.get(current.parentPid);
    const parentCreation = parent
      ? normalizedCreationDate(parent.creationDate)
      : null;
    if (
      !parent ||
      !childCreation ||
      !parentCreation ||
      childCreation.epochMs > maximumCreationEpochMs ||
      parentCreation.epochMs > maximumCreationEpochMs ||
      childCreation.epochMs < parentCreation.epochMs
    ) {
      return false;
    }
    current = parent;
  }
  const rootIdentity = processIdentity(current, maximumCreationEpochMs);
  return rootIdentity?.key === appRoot.key;
}

function validProcessTable(processes: readonly ProcessRecord[]): boolean {
  if (processes.length === 0) {
    return false;
  }
  const pids = new Set<number>();
  for (const process of processes) {
    if (!validPid(process.pid) || pids.has(process.pid)) {
      return false;
    }
    pids.add(process.pid);
  }
  return true;
}

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

function isFastFlowProcess(process: ProcessRecord): boolean {
  return process.name.trim().toLowerCase() === FASTFLOW_PROCESS_NAME;
}

function publicProcessEvidence(
  identities: Iterable<ProcessIdentity>,
): OwnedProcessEvidence[] {
  return [...identities]
    .map(({ pid, name }) => ({ pid, name }))
    .sort((left, right) => left.pid - right.pid || left.name.localeCompare(right.name));
}

function unavailableReleaseSnapshot(): ResourcesReleasedAtEndSnapshot {
  return {
    captured_at: new Date().toISOString(),
    released: false,
    pre_close_captured_at: null,
    pre_close_release_proven: false,
    pre_close_stable_empty_snapshots: 0,
    stable_empty_snapshots: 0,
    observed_owned_processes: [],
    alive_owned_processes: [],
  };
}

function recordErrorOnce(run: SmokeRunState, code: string): void {
  if (!run.metrics.errors.includes(code)) {
    run.metrics.errors.push(code);
  }
}
