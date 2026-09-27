import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const OCR_EXECUTION_PROOF_ARTIFACT = 'ocr-device-proof-v1.json' as const;

export interface OcrExecutionProofExpectation {
  readonly sourceSha256: string;
  readonly runtimeSha256: string;
  /** The producer's workerSha256 is the executable identity. */
  readonly workerExecutableSha256: string;
  readonly modelSha256: string;
  readonly profileId: string;
  readonly profileSpecSha256: string;
  readonly contractSetSha256: string;
  readonly expectedAdapterClass: 'dedicated' | 'integrated';
  readonly expectedAdapterDescriptionIncludes: string;
}

export interface OcrExecutionProofSummary {
  readonly artifactPath: typeof OCR_EXECUTION_PROOF_ARTIFACT;
  readonly bytes: number;
  readonly sha256: string;
  readonly schemaVersion: '1';
  readonly planSha256: string;
  readonly identitySha256: string;
  readonly adapterClass: 'dedicated' | 'integrated';
  readonly adapterDescription: string;
  readonly dmlDeviceId: number;
  readonly dmlNodeCount: number;
  readonly sessionCount: number;
  readonly executionSha256: string;
  readonly sourceSha256: string;
  readonly runtimeSha256: string;
  readonly workerSha256: string;
  readonly modelSha256: string;
  readonly profileId: string;
  readonly profileSpecSha256: string;
  readonly contractSetSha256: string;
  readonly requestedPageScope: readonly number[] | null;
}

type RecordValue = Record<string, unknown>;

/** Create the unique sink supplied to the installed app for one acceptance run. */
export async function createOcrExecutionEvidenceRoot(outDir: string): Promise<string> {
  const root = join(outDir, `.ocr-execution-evidence-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
}

export async function readAndValidateOcrExecutionProof(
  root: string,
  expected: OcrExecutionProofExpectation,
): Promise<OcrExecutionProofSummary> {
  const paths = await findProofFiles(root);
  if (paths.length !== 1) {
    throw new Error('OCR execution evidence must contain exactly one proof artifact.');
  }
  const path = paths[0];
  const bytes = await readFile(path).catch(() => {
    throw new Error('OCR execution proof artifact was not readable.');
  });
  if (bytes.length === 0 || bytes.length > 1024 * 1024) {
    throw new Error('OCR execution proof artifact size is invalid.');
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('OCR execution proof artifact was invalid JSON.');
  }
  const summary = validateProof(value, expected);
  return {
    ...summary,
    artifactPath: OCR_EXECUTION_PROOF_ARTIFACT,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/**
 * Validate an OCR proof before an acceptance artifact writer preserves its
 * producer bytes. This intentionally checks only the self-contained proof
 * contract; run-specific identity binding remains the responsibility of
 * readAndValidateOcrExecutionProof.
 */
export function validateCanonicalOcrExecutionProofArtifact(
  bytes: Uint8Array,
): void {
  if (bytes.length === 0 || bytes.length > 1024 * 1024) {
    throw new Error('OCR execution proof artifact size is invalid.');
  }
  const text = Buffer.from(bytes).toString('utf8');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('OCR execution proof artifact was invalid JSON.');
  }
  validateProof(value);
  if (text !== `${JSON.stringify(canonicalValue(value))}\n`) {
    throw new Error('OCR execution proof artifact was not canonical JSON.');
  }
}

async function findProofFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => {
    throw new Error('OCR execution evidence sink was not readable.');
  });
  const files: string[] = [];
  for (const entry of entries) {
    const child = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      if (entry.name === OCR_EXECUTION_PROOF_ARTIFACT) {
        throw new Error('OCR execution proof artifact must not be a symbolic link.');
      }
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await findProofFiles(child)));
    } else if (entry.isFile() && entry.name === OCR_EXECUTION_PROOF_ARTIFACT) {
      const metadata = await lstat(child);
      if (!metadata.isFile()) {
        throw new Error('OCR execution proof artifact must be a regular file.');
      }
      files.push(child);
    }
  }
  return files;
}

function validateProof(
  value: unknown,
  expected?: OcrExecutionProofExpectation,
): Omit<OcrExecutionProofSummary, 'artifactPath' | 'bytes' | 'sha256'> {
  const proof = exactRecord(value, [
    'schemaVersion',
    'selectionProof',
    'pipelineConstruction',
    'sessionDeviceProofs',
    'sourceSha256',
    'requestedPageScope',
    'dmlNodeCount',
    'runtimeSha256',
    'workerSha256',
    'modelSha256',
    'profileId',
    'profileSpecSha256',
    'contractSetSha256',
    'executionSha256',
  ]);
  if (proof.schemaVersion !== '1') fail('OCR execution proof schema is unsupported.');

  const selection = exactRecord(proof.selectionProof, [
    'identity',
    'highPerformanceRank',
    'dmlDeviceId',
    'adapterMapSha256',
    'planSha256',
  ]);
  const identity = exactRecord(selection.identity, [
    'adapterClass',
    'adapterLuid',
    'vendorId',
    'deviceId',
    'subsystemId',
    'revision',
    'description',
    'identitySha256',
  ]);
  const adapterClass = identity.adapterClass;
  if (adapterClass !== 'dedicated' && adapterClass !== 'integrated') {
    fail('OCR execution proof adapter class was invalid.');
  }
  if (expected && adapterClass !== expected.expectedAdapterClass) {
    fail('OCR execution proof adapter class did not match the acceptance expectation.');
  }
  if (typeof identity.description !== 'string' ||
      (expected !== undefined &&
       !identity.description.includes(expected.expectedAdapterDescriptionIncludes))) {
    fail('OCR execution proof adapter description did not match the acceptance expectation.');
  }
  requireHex(identity.adapterLuid, 16);
  requireHex(identity.vendorId, 4);
  requireHex(identity.deviceId, 4);
  requireHex(identity.subsystemId, 8);
  requireHex(identity.revision, 2);
  requireLabel(identity.description, 128);
  const identitySha256 = requireSha(identity.identitySha256);
  const identityWithoutDigest = {
    adapterClass: identity.adapterClass,
    adapterLuid: identity.adapterLuid,
    vendorId: identity.vendorId,
    deviceId: identity.deviceId,
    subsystemId: identity.subsystemId,
    revision: identity.revision,
    description: identity.description,
  };
  if (canonicalSha256(identityWithoutDigest) !== identitySha256) {
    fail('OCR execution proof adapter identity digest was invalid.');
  }

  const dmlDeviceId = requireNonNegativeInteger(selection.dmlDeviceId);
  requireNonNegativeInteger(selection.highPerformanceRank);
  const adapterMapSha256 = requireSha(selection.adapterMapSha256);
  const planSha256 = requireSha(selection.planSha256);
  const construction = exactRecord(proof.pipelineConstruction, ['pre', 'post']);
  const constructionSides = [construction.pre, construction.post].map((side) =>
    exactRecord(side, ['adapterLuid', 'adapterMapSha256', 'factoryCurrent']),
  );
  for (const side of constructionSides) {
    requireHex(side.adapterLuid, 16);
    if (requireSha(side.adapterMapSha256) !== adapterMapSha256 || side.factoryCurrent !== true) {
      fail('OCR execution proof pipeline construction was not current and selection-bound.');
    }
  }
  if (constructionSides[0]?.adapterLuid !== constructionSides[1]?.adapterLuid ||
      constructionSides[0]?.adapterLuid !== identity.adapterLuid) {
    fail('OCR execution proof pipeline construction drifted from adapter selection.');
  }

  if (!Array.isArray(proof.sessionDeviceProofs) || proof.sessionDeviceProofs.length < 1 ||
      proof.sessionDeviceProofs.length > 500) {
    fail('OCR execution proof session evidence was invalid.');
  }
  let dmlNodeCount = 0;
  proof.sessionDeviceProofs.forEach((item, index) => {
    const session = exactRecord(item, [
      'sessionIndex',
      'providerOrder',
      'dmlDeviceId',
      'fallbackDisabled',
      'dmlNodeCount',
      'cpuNodeCount',
      'evidenceSource',
    ]);
    if (session.sessionIndex !== index ||
        JSON.stringify(session.providerOrder) !== JSON.stringify(['DmlExecutionProvider', 'CPUExecutionProvider'])) {
      fail('OCR execution proof provider order was invalid.');
    }
    if ((session.dmlDeviceId !== null && session.dmlDeviceId !== dmlDeviceId) ||
        session.fallbackDisabled !== true) {
      fail('OCR execution proof session device or fallback evidence drifted.');
    }
    const sessionDmlNodes = requirePositiveInteger(session.dmlNodeCount);
    requireNonNegativeInteger(session.cpuNodeCount);
    if (session.evidenceSource !== 'ort-graph-assignment' && session.evidenceSource !== 'ort-profile') {
      fail('OCR execution proof evidence source was invalid.');
    }
    dmlNodeCount += sessionDmlNodes;
  });
  const aggregateDmlNodeCount = requirePositiveInteger(proof.dmlNodeCount);
  if (aggregateDmlNodeCount !== dmlNodeCount) fail('OCR execution proof DML aggregate was invalid.');

  const requestedPageScope = proof.requestedPageScope === null
    ? null
    : (() => {
        if (!Array.isArray(proof.requestedPageScope) || proof.requestedPageScope.length < 1 ||
            proof.requestedPageScope.length > 500 || proof.requestedPageScope.some((page, index) => page !== index + 1)) {
          fail('OCR execution proof requested page scope was invalid.');
        }
        return proof.requestedPageScope.map((page) => Number(page));
      })();

  const sourceSha256 = requireSha(proof.sourceSha256);
  const runtimeSha256 = requireSha(proof.runtimeSha256);
  const workerSha256 = requireSha(proof.workerSha256);
  const modelSha256 = requireSha(proof.modelSha256);
  const profileId = requireLabel(proof.profileId, 128);
  const profileSpecSha256 = requireSha(proof.profileSpecSha256);
  const contractSetSha256 = requireSha(proof.contractSetSha256);
  if (expected) {
    for (const [name, actual, wanted] of [
      ['source', sourceSha256, expected.sourceSha256],
      ['runtime', runtimeSha256, expected.runtimeSha256],
      ['worker', workerSha256, expected.workerExecutableSha256],
      ['model', modelSha256, expected.modelSha256],
      ['profile', profileSpecSha256, expected.profileSpecSha256],
      ['contract', contractSetSha256, expected.contractSetSha256],
    ] as const) {
      if (actual !== wanted) fail(`OCR execution proof ${name} identity did not match the acceptance expectation.`);
    }
  }
  if (expected && profileId !== expected.profileId) fail('OCR execution proof profile identity did not match the acceptance expectation.');

  const executionSha256 = requireSha(proof.executionSha256);
  const withoutDigest = Object.fromEntries(
    Object.entries(proof).filter(([key]) => key !== 'executionSha256'),
  );
  if (canonicalSha256(withoutDigest) !== executionSha256) fail('OCR execution proof digest was invalid.');
  return {
    schemaVersion: '1',
    planSha256,
    identitySha256,
    adapterClass,
    adapterDescription: identity.description,
    dmlDeviceId,
    dmlNodeCount: aggregateDmlNodeCount,
    sessionCount: proof.sessionDeviceProofs.length,
    executionSha256,
    sourceSha256,
    runtimeSha256,
    workerSha256,
    modelSha256,
    profileId,
    profileSpecSha256,
    contractSetSha256,
    requestedPageScope,
  };
}

function exactRecord(value: unknown, keys: readonly string[]): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('OCR execution proof record was invalid.');
  const record = value as RecordValue;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('OCR execution proof record contained unsupported fields.');
  }
  return record;
}

function requireSha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail('OCR execution proof SHA-256 field was invalid.');
  return value;
}

function requireHex(value: unknown, width: number): string {
  if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${width}}$`, 'u').test(value)) fail('OCR execution proof hardware identity was invalid.');
  return value;
}

function requireLabel(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || !/^[A-Za-z0-9 ._:-]+$/u.test(value)) fail('OCR execution proof label was invalid.');
  return value;
}

function requireNonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('OCR execution proof integer was invalid.');
  return value;
}

function requirePositiveInteger(value: unknown): number {
  const number = requireNonNegativeInteger(value);
  if (number < 1) fail('OCR execution proof positive integer was invalid.');
  return number;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as RecordValue).sort().map((key) => [key, canonicalValue((value as RecordValue)[key])]));
  }
  return value;
}

function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
}

function fail(message: string): never {
  throw new Error(message);
}
