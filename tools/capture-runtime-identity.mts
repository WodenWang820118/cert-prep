const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

export type CaptureRuntimeIdentityMode = 'release' | 'local-probe';

export interface CaptureRuntimeProbeIdentity {
  readonly runtimeVersion: string;
  readonly apiVersion: '2.0';
  readonly ocrProjectionSchemaVersion: '3';
  readonly contractSetSha256: string;
  readonly sourceCommit: string;
  readonly core: {
    readonly fileName: string;
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly worker: {
    readonly fileName: string;
    readonly sha256: string;
    readonly bytes: number;
  };
}

export interface CaptureRuntimeObservedIdentity {
  readonly runtimeVersion: string;
  readonly apiVersion: string;
  readonly ocrProjectionSchemaVersion: string;
  readonly contractSetSha256: string;
  readonly coreSha256: string;
  readonly coreBytes: number;
  readonly workerSha256?: string;
  readonly workerBytes?: number;
}

export interface CaptureRuntimeIdentityReport {
  readonly mode: CaptureRuntimeIdentityMode;
  readonly hardChecks: readonly {
    readonly name: string;
    readonly status: 'passed';
  }[];
  readonly softChecks: readonly {
    readonly name: string;
    readonly status: 'recorded';
    readonly observed: string;
    readonly expected?: string;
  }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  label: string,
  pattern?: RegExp,
): string {
  if (
    typeof value !== 'string' ||
    !value ||
    (pattern && !pattern.test(value))
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requiredBytes(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} bytes are invalid.`);
  }
  return value;
}

function requiredArtifact(
  artifacts: readonly unknown[],
  predicate: (value: Record<string, unknown>) => boolean,
  label: string,
): CaptureRuntimeProbeIdentity['core'] {
  const matches = artifacts.filter(
    (value): value is Record<string, unknown> =>
      isRecord(value) && predicate(value),
  );
  if (matches.length !== 1) {
    throw new Error(
      `Probe manifest must contain exactly one ${label} artifact.`,
    );
  }
  const artifact = matches[0];
  return {
    fileName: requiredString(artifact.id, `${label} artifact id`),
    sha256: requiredString(
      artifact.sha256,
      `${label} artifact sha256`,
      SHA256_PATTERN,
    ),
    bytes: requiredBytes(artifact.bytes, `${label} artifact`),
  };
}

/**
 * Parses the producer's immutable phase-1 probe identity.  The probe is a
 * small metadata document; the actual runtime and worker bytes are always
 * hashed by the consumer at the package boundary.
 */
export function parseCaptureRuntimeProbe(
  raw: unknown,
): CaptureRuntimeProbeIdentity {
  if (!isRecord(raw) || raw.manifestKind !== 'capture-phase1-probe') {
    throw new Error('Capture Runtime probe manifest kind is invalid.');
  }
  const runtimeVersion = requiredString(
    raw.runtimeVersion,
    'Probe runtimeVersion',
    SEMVER_PATTERN,
  );
  const apiVersion = requiredString(raw.apiVersion, 'Probe apiVersion');
  if (apiVersion !== '2.0') {
    throw new Error('Probe API version must be 2.0.');
  }
  const ocrProjectionSchemaVersion = requiredString(
    raw.ocrProjectionSchemaVersion,
    'Probe OCR projection schema version',
  );
  if (ocrProjectionSchemaVersion !== '3') {
    throw new Error('Probe OCR projection schema version must be 3.');
  }
  const sourceCommit = requiredString(
    raw.sourceCommit,
    'Probe sourceCommit',
    GIT_SHA_PATTERN,
  );
  const contractSetSha256 = requiredString(
    raw.contractSetSha256,
    'Probe contractSetSha256',
    SHA256_PATTERN,
  );
  if (!Array.isArray(raw.artifacts)) {
    throw new Error('Probe artifacts must be an array.');
  }
  const core = requiredArtifact(
    raw.artifacts,
    (value) => value.id === 'capture-runtime-x86_64-pc-windows-msvc.exe',
    'Capture Runtime core',
  );
  const worker = requiredArtifact(
    raw.artifacts,
    (value) =>
      typeof value.id === 'string' &&
      /^capture-engine-ocr-\d+\.\d+\.\d+(?:-[^/]+)?-windows-x64\.zip$/u.test(
        value.id,
      ),
    'WindowsML OCR worker',
  );
  return {
    runtimeVersion,
    apiVersion: '2.0',
    ocrProjectionSchemaVersion: '3',
    contractSetSha256,
    sourceCommit,
    core,
    worker,
  };
}

function assertDigest(value: string | undefined, label: string): string {
  if (!value || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

/**
 * Applies the small identity interface shared by candidate and local-probe
 * gates.  Release mode still validates the complete internal contract; only
 * local-probe mode relaxes semver/package metadata and binds bytes to the
 * producer probe.
 */
export function assertCaptureRuntimeIdentity(input: {
  readonly mode: CaptureRuntimeIdentityMode;
  readonly observed: CaptureRuntimeObservedIdentity;
  readonly probe?: CaptureRuntimeProbeIdentity;
}): CaptureRuntimeIdentityReport {
  const { mode, observed, probe } = input;
  if (mode === 'local-probe' && !probe) {
    throw new Error('Local-probe identity requires a producer probe manifest.');
  }
  requiredString(observed.runtimeVersion, 'Observed runtimeVersion');
  if (observed.apiVersion !== '2.0') {
    throw new Error('Capture Runtime API version must be 2.0.');
  }
  if (observed.ocrProjectionSchemaVersion !== '3') {
    throw new Error('Capture Runtime OCR projection schema version must be 3.');
  }
  const contractSetSha256 = assertDigest(
    observed.contractSetSha256,
    'Observed contractSetSha256',
  );
  const coreSha256 = assertDigest(observed.coreSha256, 'Observed core sha256');
  if (!Number.isSafeInteger(observed.coreBytes) || observed.coreBytes < 1) {
    throw new Error('Observed core bytes are invalid.');
  }
  const workerSha256 = observed.workerSha256
    ? assertDigest(observed.workerSha256, 'Observed OCR worker sha256')
    : undefined;
  if (observed.workerBytes !== undefined) {
    requiredBytes(observed.workerBytes, 'Observed OCR worker');
  }
  if (mode === 'local-probe') {
    if (!workerSha256) {
      throw new Error('Local-probe identity requires a loaded OCR worker.');
    }
    if (observed.apiVersion !== probe!.apiVersion) {
      throw new Error('Loaded Capture Runtime API does not match the probe.');
    }
    if (
      observed.ocrProjectionSchemaVersion !== probe!.ocrProjectionSchemaVersion
    ) {
      throw new Error(
        'Loaded OCR projection schema does not match the producer probe.',
      );
    }
    if (contractSetSha256 !== probe!.contractSetSha256) {
      throw new Error('Loaded contract set does not match the producer probe.');
    }
    if (coreSha256 !== probe!.core.sha256) {
      throw new Error(
        'Loaded Capture Runtime core does not match the producer probe.',
      );
    }
    if (workerSha256 !== probe!.worker.sha256) {
      throw new Error('Loaded OCR worker does not match the producer probe.');
    }
  }
  return {
    mode,
    hardChecks: [
      { name: 'capture-runtime-api-2.0', status: 'passed' },
      { name: 'capture-ocr-projection-schema-3', status: 'passed' },
      { name: 'capture-contract-set-sha256', status: 'passed' },
      { name: 'capture-runtime-core-sha256', status: 'passed' },
      ...(workerSha256
        ? [{ name: 'capture-ocr-worker-sha256', status: 'passed' as const }]
        : []),
    ],
    softChecks: [
      {
        name: 'capture-runtime-version',
        status: 'recorded',
        observed: observed.runtimeVersion,
        ...(probe ? { expected: probe.runtimeVersion } : {}),
      },
      {
        name: 'capture-runtime-core-bytes',
        status: 'recorded',
        observed: String(observed.coreBytes),
        ...(probe ? { expected: String(probe.core.bytes) } : {}),
      },
      ...(observed.workerBytes !== undefined
        ? [
            {
              name: 'capture-ocr-worker-bytes',
              status: 'recorded' as const,
              observed: String(observed.workerBytes),
              ...(probe ? { expected: String(probe.worker.bytes) } : {}),
            },
          ]
        : []),
    ],
  };
}
