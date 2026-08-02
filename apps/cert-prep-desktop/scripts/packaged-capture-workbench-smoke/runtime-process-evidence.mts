import { spawnSync } from 'node:child_process';

import {
  collectProcessTree,
  resolveWindowsPowerShellExecutable,
  snapshotWindowsProcesses,
  type ProcessRecord,
} from '../process-lifecycle/processes.mts';
import type { RuntimeProcessIdentity } from './journey-contract.mts';

const LISTENER_SNAPSHOT_TIMEOUT_MS = 15_000;
const LISTENER_SNAPSHOT_MAX_BUFFER = 16 * 1024 * 1024;

interface JsonListeningPortRow {
  readonly OwningProcess?: unknown;
  readonly LocalAddress?: unknown;
  readonly LocalPort?: unknown;
}

export interface ListeningPortRecord {
  readonly pid: number;
  readonly address: string;
  readonly port: number;
}

export interface OwnedRuntimePhaseEvidence {
  readonly backendProcesses: RuntimeProcessIdentity[];
  readonly backendListenerPorts: number[];
  readonly captureProcesses: RuntimeProcessIdentity[];
  readonly captureListenerPorts: number[];
}

export function parseListeningPortSnapshotJson(
  stdout: string,
): ListeningPortRecord[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  const payload = JSON.parse(trimmed) as
    | JsonListeningPortRow
    | JsonListeningPortRow[];
  const rows = Array.isArray(payload) ? payload : [payload];
  return rows
    .map((row) => ({
      pid: numericField(row.OwningProcess),
      address: stringField(row.LocalAddress),
      port: numericField(row.LocalPort),
    }))
    .filter(
      (row) =>
        row.pid > 0 &&
        row.port > 0 &&
        row.port <= 65_535 &&
        row.address.length > 0,
    );
}

export function snapshotWindowsListeningPorts(): ListeningPortRecord[] {
  if (process.platform !== 'win32') {
    return [];
  }
  const result = spawnSync(
    resolveWindowsPowerShellExecutable(),
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      "$ErrorActionPreference = 'Stop'; Get-NetTCPConnection -State Listen | Select-Object OwningProcess,LocalAddress,LocalPort | ConvertTo-Json -Compress",
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: LISTENER_SNAPSHOT_TIMEOUT_MS,
      maxBuffer: LISTENER_SNAPSHOT_MAX_BUFFER,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error('Listening-port snapshot failed.');
  }
  return parseListeningPortSnapshotJson(result.stdout);
}

export function snapshotOwnedRuntimePhase(
  appPid: number,
): OwnedRuntimePhaseEvidence {
  return ownedRuntimePhaseFromSnapshots(
    snapshotWindowsProcesses(),
    snapshotWindowsListeningPorts(),
    appPid,
  );
}

export function ownedRuntimePhaseFromSnapshots(
  processes: readonly ProcessRecord[],
  listeners: readonly ListeningPortRecord[],
  appPid: number,
): OwnedRuntimePhaseEvidence {
  const owned = collectProcessTree(processes, appPid);
  const backend = owned.filter(isBackendProcess);
  const capture = owned.filter(isCaptureRuntimeProcess);
  const backendPids = new Set(backend.map((record) => record.pid));
  const capturePids = new Set(capture.map((record) => record.pid));
  return {
    backendProcesses: backend.map(processIdentity),
    backendListenerPorts: listenerPortsForPids(listeners, backendPids),
    captureProcesses: capture.map(processIdentity),
    captureListenerPorts: listenerPortsForPids(listeners, capturePids),
  };
}

export function isOwnedBackendOnly(
  evidence: OwnedRuntimePhaseEvidence,
): boolean {
  return (
    evidence.backendProcesses.length >= 1 &&
    evidence.backendListenerPorts.length > 0 &&
    evidence.captureProcesses.length === 0 &&
    evidence.captureListenerPorts.length === 0
  );
}

export function isOwnedBackendAndCaptureRunning(
  evidence: OwnedRuntimePhaseEvidence,
): boolean {
  return (
    evidence.backendProcesses.length >= 1 &&
    evidence.backendListenerPorts.length > 0 &&
    evidence.captureProcesses.length >= 1 &&
    evidence.captureListenerPorts.length > 0
  );
}

export function assertCapturedRuntimeCleared(
  captured: OwnedRuntimePhaseEvidence,
  currentProcesses: readonly ProcessRecord[],
  currentListeners: readonly ListeningPortRecord[],
): void {
  const capturedProcesses = [
    ...captured.backendProcesses,
    ...captured.captureProcesses,
  ];
  const processResidue = currentProcesses.filter((current) =>
    capturedProcesses.some(
      (expected) =>
        current.pid === expected.pid &&
        current.creationDate === expected.creationDate,
    ),
  );
  if (processResidue.length > 0) {
    throw new Error('Packaged Capture Workbench close left owned process residue.');
  }
  const capturedPorts = new Set([
    ...captured.backendListenerPorts,
    ...captured.captureListenerPorts,
  ]);
  if (currentListeners.some((listener) => capturedPorts.has(listener.port))) {
    throw new Error('Packaged Capture Workbench close left listener residue.');
  }
}

function listenerPortsForPids(
  listeners: readonly ListeningPortRecord[],
  pids: ReadonlySet<number>,
): number[] {
  return [
    ...new Set(
      listeners
        .filter((listener) => pids.has(listener.pid))
        .map((listener) => listener.port),
    ),
  ].sort((left, right) => left - right);
}

function isBackendProcess(record: ProcessRecord): boolean {
  return record.name.toLowerCase() === 'cert-prep-backend.exe';
}

function isCaptureRuntimeProcess(record: ProcessRecord): boolean {
  return record.name.toLowerCase().includes('capture-runtime');
}

function processIdentity(record: ProcessRecord): RuntimeProcessIdentity {
  return {
    pid: record.pid,
    creationDate: record.creationDate,
    imagePath: record.executablePath,
  };
}

function numericField(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value);
  }
  return 0;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
