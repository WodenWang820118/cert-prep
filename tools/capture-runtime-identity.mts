const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

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
  readonly mode: 'release';
  readonly hardChecks: readonly {
    readonly name: string;
    readonly status: 'passed';
  }[];
  readonly softChecks: readonly {
    readonly name: string;
    readonly status: 'recorded';
    readonly observed: string;
  }[];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
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

function assertDigest(value: string | undefined, label: string): string {
  if (!value || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}
export function assertCaptureRuntimeIdentity(input: {
  readonly observed: CaptureRuntimeObservedIdentity;
}): CaptureRuntimeIdentityReport {
  const { observed } = input;
  requiredString(observed.runtimeVersion, 'Observed runtimeVersion');
  if (observed.apiVersion !== '2.0') {
    throw new Error('Capture Runtime API version must be 2.0.');
  }
  if (observed.ocrProjectionSchemaVersion !== '3') {
    throw new Error('Capture Runtime OCR projection schema version must be 3.');
  }
  assertDigest(observed.contractSetSha256, 'Observed contractSetSha256');
  assertDigest(observed.coreSha256, 'Observed core sha256');
  if (!Number.isSafeInteger(observed.coreBytes) || observed.coreBytes < 1) {
    throw new Error('Observed core bytes are invalid.');
  }
  const workerSha256 = observed.workerSha256
    ? assertDigest(observed.workerSha256, 'Observed OCR worker sha256')
    : undefined;
  if (observed.workerBytes !== undefined) {
    requiredBytes(observed.workerBytes, 'Observed OCR worker');
  }
  return {
    mode: 'release',
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
      },
      {
        name: 'capture-runtime-core-bytes',
        status: 'recorded',
        observed: String(observed.coreBytes),
      },
      ...(observed.workerBytes !== undefined
        ? [
            {
              name: 'capture-ocr-worker-bytes',
              status: 'recorded' as const,
              observed: String(observed.workerBytes),
            },
          ]
        : []),
    ],
  };
}
