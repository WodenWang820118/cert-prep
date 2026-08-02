export interface RuntimeProcessIdentity {
  readonly pid: number;
  readonly creationDate: string;
  readonly imagePath: string;
}

export type NormalizedCaptureRuntimeStatus =
  | 'missing'
  | 'installed-stopped'
  | 'running'
  | 'closed';

export interface LazyRuntimePhaseSnapshot {
  readonly captureStatus: NormalizedCaptureRuntimeStatus;
  readonly backendReady: boolean;
  readonly backendProcesses: readonly RuntimeProcessIdentity[];
  readonly backendListenerPorts: readonly number[];
  readonly captureProcesses: readonly RuntimeProcessIdentity[];
  readonly captureListenerPorts: readonly number[];
  readonly runtimeRouteVisible?: boolean;
  readonly pythonBackendConsentCompleted?: boolean;
  readonly backendConfigurationChanged?: boolean;
  readonly priorBackendAccessRejected?: boolean;
  readonly persistedDocumentVisible?: boolean;
}

export interface LazyCaptureRuntimeJourney {
  readonly firstShell: LazyRuntimePhaseSnapshot;
  readonly backendReadyCaptureMissing: LazyRuntimePhaseSnapshot;
  readonly captureInstalledStopped: LazyRuntimePhaseSnapshot;
  readonly captureRunning: LazyRuntimePhaseSnapshot;
  readonly firstClose: LazyRuntimePhaseSnapshot;
  readonly relaunchedInstalledStopped: LazyRuntimePhaseSnapshot;
  readonly relaunchedRunningPersisted: LazyRuntimePhaseSnapshot;
  readonly finalClose: LazyRuntimePhaseSnapshot;
}

/** Enforces the fresh-app-data lazy runtime acceptance sequence. */
export function assertLazyCaptureRuntimeJourney(
  journey: LazyCaptureRuntimeJourney,
): void {
  assertProcessIdentities(journey);
  assertStopped(
    journey.firstShell,
    'Fresh shell must not start Capture Runtime',
  );
  if (
    journey.firstShell.backendReady ||
    journey.firstShell.backendProcesses.length !== 0 ||
    journey.firstShell.backendListenerPorts.length !== 0 ||
    journey.firstShell.runtimeRouteVisible !== true
  ) {
    throw new Error(
      'Fresh shell must expose /runtime before the Python backend consent flow.',
    );
  }

  assertBackendReady(journey.backendReadyCaptureMissing, 'Python backend consent');
  assertStopped(
    journey.backendReadyCaptureMissing,
    'Python backend readiness must not start Capture Runtime',
  );
  if (
    journey.backendReadyCaptureMissing.captureStatus !== 'missing' ||
    journey.backendReadyCaptureMissing.pythonBackendConsentCompleted !== true
  ) {
    throw new Error(
      'Python backend must become ready through explicit consent while Capture Runtime remains missing.',
    );
  }

  assertBackendReady(journey.captureInstalledStopped, 'Capture Runtime install');
  assertStopped(
    journey.captureInstalledStopped,
    'Install must leave Capture Runtime stopped',
  );
  if (journey.captureInstalledStopped.captureStatus !== 'installed-stopped') {
    throw new Error('Install must report Capture Runtime as installed-stopped.');
  }
  if (
    !sameProcessSet(
      journey.backendReadyCaptureMissing.backendProcesses,
      journey.captureInstalledStopped.backendProcesses,
    ) ||
    !sameNumberSet(
      journey.backendReadyCaptureMissing.backendListenerPorts,
      journey.captureInstalledStopped.backendListenerPorts,
    )
  ) {
    throw new Error('Capture Runtime install must not restart the owned backend.');
  }

  assertBackendReady(journey.captureRunning, 'Capture Runtime start');
  if (
    journey.captureRunning.captureStatus !== 'running' ||
    journey.captureRunning.captureProcesses.length === 0 ||
    journey.captureRunning.captureListenerPorts.length === 0
  ) {
    throw new Error(
      'Start must produce an owned Capture Runtime process and listener.',
    );
  }
  if (
    sharesProcessIdentity(
      journey.captureInstalledStopped.backendProcesses,
      journey.captureRunning.backendProcesses,
    ) ||
    journey.captureRunning.backendConfigurationChanged !== true
  ) {
    throw new Error(
      'Start must produce a fresh owned backend identity and new configuration.',
    );
  }
  if (journey.captureRunning.priorBackendAccessRejected !== true) {
    throw new Error('The prior backend access credential must be rejected after Start.');
  }

  assertClosed(journey.firstClose, 'First close');

  assertBackendReady(
    journey.relaunchedInstalledStopped,
    'Relaunch installed-stopped state',
  );
  assertStopped(
    journey.relaunchedInstalledStopped,
    'Relaunch must not auto-start Capture Runtime',
  );
  if (journey.relaunchedInstalledStopped.captureStatus !== 'installed-stopped') {
    throw new Error('Relaunch must report Capture Runtime as installed-stopped.');
  }

  assertBackendReady(
    journey.relaunchedRunningPersisted,
    'Relaunched Capture Runtime start',
  );
  if (
    journey.relaunchedRunningPersisted.captureStatus !== 'running' ||
    journey.relaunchedRunningPersisted.captureProcesses.length === 0 ||
    journey.relaunchedRunningPersisted.captureListenerPorts.length === 0 ||
    journey.relaunchedRunningPersisted.persistedDocumentVisible !== true
  ) {
    throw new Error(
      'The second explicit Start must expose the persisted document with an owned sidecar listener.',
    );
  }

  assertClosed(journey.finalClose, 'Final close');
}

function assertBackendReady(
  phase: LazyRuntimePhaseSnapshot,
  label: string,
): void {
  if (
    !phase.backendReady ||
    phase.backendProcesses.length === 0 ||
    phase.backendListenerPorts.length === 0
  ) {
    throw new Error(`${label} must have a live owned backend.`);
  }
}

function assertStopped(
  phase: LazyRuntimePhaseSnapshot,
  label: string,
): void {
  if (
    phase.captureProcesses.length !== 0 ||
    phase.captureListenerPorts.length !== 0
  ) {
    throw new Error(`${label}: process and listener counts must both be zero.`);
  }
}

function assertClosed(phase: LazyRuntimePhaseSnapshot, label: string): void {
  if (
    phase.captureStatus !== 'closed' ||
    phase.backendReady ||
    phase.backendProcesses.length !== 0 ||
    phase.backendListenerPorts.length !== 0 ||
    phase.captureProcesses.length !== 0 ||
    phase.captureListenerPorts.length !== 0
  ) {
    throw new Error(`${label} must leave owned process and listener residue at zero.`);
  }
}

function assertProcessIdentities(journey: LazyCaptureRuntimeJourney): void {
  for (const [phaseName, phase] of Object.entries(journey) as Array<
    [string, LazyRuntimePhaseSnapshot]
  >) {
    for (const process of [
      ...phase.backendProcesses,
      ...phase.captureProcesses,
    ]) {
      if (
        !Number.isSafeInteger(process.pid) ||
        process.pid <= 0 ||
        process.creationDate.trim().length === 0 ||
        process.imagePath.trim().length === 0
      ) {
        throw new Error(`${phaseName} contains an incomplete process identity.`);
      }
    }
    if (
      [...phase.backendListenerPorts, ...phase.captureListenerPorts].some(
        (port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535,
      )
    ) {
      throw new Error(`${phaseName} contains an invalid listener port.`);
    }
  }
}

function sameProcessSet(
  left: readonly RuntimeProcessIdentity[],
  right: readonly RuntimeProcessIdentity[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightIdentities = new Set(right.map(processKey));
  return left.every((process) => rightIdentities.has(processKey(process)));
}

function sameNumberSet(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value))
  );
}

function sharesProcessIdentity(
  left: readonly RuntimeProcessIdentity[],
  right: readonly RuntimeProcessIdentity[],
): boolean {
  const leftIdentities = new Set(left.map(processKey));
  return right.some((process) => leftIdentities.has(processKey(process)));
}

function processKey(process: RuntimeProcessIdentity): string {
  return `${process.pid}:${process.creationDate}`;
}
