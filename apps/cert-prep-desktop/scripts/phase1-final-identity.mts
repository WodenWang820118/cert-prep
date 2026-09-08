import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { isRecord } from './packaged-flow-smoke/text-utils.mts';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_RELATIVE_PATH = /^(?![\\/])[^<>:"|?*]+$/u;

export const PHASE1_FINAL_IDENTITY = Object.freeze({
  manifestKind: 'capture-runtime-phase1-final',
  manifestVersion: 3,
  runtimeVersion: '0.4.2',
  runtimeArtifactSha256:
    '3d37b8507e44069ea6f9f29643b4bc9c3941550fd81481b558df5e2f4c9d029b',
  ocrWorkerArchiveSha256:
    '424d55ea67dcab9eff9e17998426111f0c5ad090e776f4f98e669bef03b1174e',
  ocrWorkerExecutableSha256:
    'b26cbb2d55eae84d00c7bae4aeadf73cb602ef68556face5efefd44fb250d887',
  contractSetSha256:
    'd293a3de26114f1b4fd65ea6d6d3f157fa2f93109b31e1e30d5d15ef0dfdeb40',
  jpegSha256:
    '9b1a9a87bae10ecd07b4b7874d5f8e46fbd8b798cc0becb20825636637da99b1',
  pdfSha256:
    'ec5f312d5c97ee91b87ec7fcbf1d33b4f4019fca367df376b48c1f4943a744c8',
  pdfSourcePageCount: 46,
  pageNumbers: Object.freeze([1]),
  expectedAnchorCount: 1,
  authenticatedRuntimePreflight: 'gpu-dml',
});

export type Phase1FinalIdentity = typeof PHASE1_FINAL_IDENTITY;

export interface Phase1FinalEvidence {
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly sourceHead: string;
  readonly identity: {
    readonly runtimeVersion: string;
    readonly runtimeArtifactSha256: string;
    readonly ocrWorkerArchiveSha256: string;
    readonly ocrWorkerExecutableSha256: string;
    readonly contractSetSha256: string;
  };
  readonly jpeg: Phase1JourneyEvidence;
  readonly pdfPage1: Phase1PdfJourneyEvidence;
}

export interface Phase1JourneyEvidence {
  readonly runId: string;
  readonly sourceSha256: string;
  readonly importedSourceSha256: string;
  readonly acceptanceManifestSha256: string;
  readonly acceptanceManifestPath: string;
  readonly authenticatedRuntimePreflight: 'gpu-dml';
  readonly uiGpuBeforeImport: true;
  readonly expectedAnchorCount: 1;
  readonly matchedAnchorCount: 1;
  readonly cleanup: Phase1CleanupEvidence;
}

export interface Phase1PdfJourneyEvidence extends Phase1JourneyEvidence {
  readonly pageScope: {
    readonly sourcePageCount: 46;
    readonly requestedPageNumbers: readonly [1];
    readonly processedPageNumbers: readonly [1];
    readonly uiRawPageNumbers: readonly [1];
    readonly uiStructuredPageNumbers: readonly [1];
  };
}

export interface Phase1CleanupEvidence {
  readonly app: true;
  readonly sidecar: true;
  readonly cdpPort: true;
  readonly temporaryAppData: true;
  readonly ownedPids: true;
  readonly ownedListeners: true;
  readonly ownedWorkers: true;
}

/**
 * Read and verify the producer's immutable Phase 1 aggregate. The aggregate
 * carries hashes/counts only; child manifests are re-hashed from disk before
 * their status is trusted, so a stale or edited Capture artifact cannot
 * silently become a Cert Prep candidate identity.
 */
export async function loadPhase1FinalEvidence(
  manifestPath: string,
  options: {
    readonly producerRoot?: string;
  } = {},
): Promise<Phase1FinalEvidence> {
  const resolvedManifestPath = resolve(manifestPath);
  const manifestBytes = await readRequiredFile(
    resolvedManifestPath,
    'Capture Runtime Phase 1 final aggregate',
  );
  const manifest = parseJsonRecord(
    manifestBytes,
    'Capture Runtime Phase 1 final aggregate',
  );
  assertEqual(manifest.manifestKind, PHASE1_FINAL_IDENTITY.manifestKind, 'manifestKind');
  assertEqual(manifest.manifestVersion, PHASE1_FINAL_IDENTITY.manifestVersion, 'manifestVersion');
  assertEqual(manifest.status, 'completed', 'status');

  const identity = recordField(manifest, 'identity');
  assertEqual(identity.runtimeVersion, PHASE1_FINAL_IDENTITY.runtimeVersion, 'identity.runtimeVersion');
  assertDigestEqual(
    identity.runtimeArtifactSha256,
    PHASE1_FINAL_IDENTITY.runtimeArtifactSha256,
    'identity.runtimeArtifactSha256',
  );
  assertDigestEqual(
    identity.ocrWorkerArchiveSha256,
    PHASE1_FINAL_IDENTITY.ocrWorkerArchiveSha256,
    'identity.ocrWorkerArchiveSha256',
  );
  assertDigestEqual(
    identity.ocrWorkerExecutableSha256,
    PHASE1_FINAL_IDENTITY.ocrWorkerExecutableSha256,
    'identity.ocrWorkerExecutableSha256',
  );
  assertDigestEqual(
    identity.contractSetSha256,
    PHASE1_FINAL_IDENTITY.contractSetSha256,
    'identity.contractSetSha256',
  );

  const producerRoot = resolve(
    options.producerRoot ??
      dirname(dirname(dirname(dirname(resolvedManifestPath)))),
  );
  const jpeg = await loadJourneyEvidence(
    manifest,
    'jpeg',
    producerRoot,
    PHASE1_FINAL_IDENTITY.jpegSha256,
  );
  const pdfPage1 = await loadJourneyEvidence(
    manifest,
    'pdfPage1',
    producerRoot,
    PHASE1_FINAL_IDENTITY.pdfSha256,
    true,
  );

  const sourceHead = requiredString(manifest.sourceHead, 'sourceHead');
  if (!/^[a-f0-9]{40}$/u.test(sourceHead)) {
    throw new Error('Capture Runtime Phase 1 final sourceHead is invalid.');
  }
  return {
    manifestPath: resolvedManifestPath,
    manifestSha256: sha256(manifestBytes),
    sourceHead,
    identity: {
      runtimeVersion: PHASE1_FINAL_IDENTITY.runtimeVersion,
      runtimeArtifactSha256: PHASE1_FINAL_IDENTITY.runtimeArtifactSha256,
      ocrWorkerArchiveSha256: PHASE1_FINAL_IDENTITY.ocrWorkerArchiveSha256,
      ocrWorkerExecutableSha256: PHASE1_FINAL_IDENTITY.ocrWorkerExecutableSha256,
      contractSetSha256: PHASE1_FINAL_IDENTITY.contractSetSha256,
    },
    jpeg,
    pdfPage1,
  };
}

async function loadJourneyEvidence(
  manifest: Record<string, unknown>,
  key: 'jpeg',
  producerRoot: string,
  expectedSourceSha256: string,
): Promise<Phase1JourneyEvidence>;
async function loadJourneyEvidence(
  manifest: Record<string, unknown>,
  key: 'pdfPage1',
  producerRoot: string,
  expectedSourceSha256: string,
  pdf: true,
): Promise<Phase1PdfJourneyEvidence>;
async function loadJourneyEvidence(
  manifest: Record<string, unknown>,
  key: 'jpeg' | 'pdfPage1',
  producerRoot: string,
  expectedSourceSha256: string,
  pdf = key === 'pdfPage1',
): Promise<Phase1JourneyEvidence | Phase1PdfJourneyEvidence> {
  const journey = recordField(manifest, key);
  assertEqual(journey.status, 'completed', `${key}.status`);
  const sourceSha256 = digestField(journey, 'sourceSha256', `${key}.sourceSha256`);
  const importedSourceSha256 = digestField(
    journey,
    'importedSourceSha256',
    `${key}.importedSourceSha256`,
  );
  assertDigestEqual(sourceSha256, expectedSourceSha256, `${key}.sourceSha256`);
  assertDigestEqual(
    importedSourceSha256,
    expectedSourceSha256,
    `${key}.importedSourceSha256`,
  );
  const acceptanceManifestSha256 = digestField(
    journey,
    'acceptanceManifestSha256',
    `${key}.acceptanceManifestSha256`,
  );
  const acceptanceManifestPath = relativeAggregatePath(
    journey.sanitizedAcceptanceManifest,
    producerRoot,
    `${key}.sanitizedAcceptanceManifest`,
  );
  const childPath = join(producerRoot, acceptanceManifestPath);
  const childBytes = await readRequiredFile(childPath, `${key} acceptance manifest`);
  if (sha256(childBytes) !== acceptanceManifestSha256) {
    throw new Error(`${key} acceptance manifest SHA-256 does not match the aggregate.`);
  }
  const child = parseJsonRecord(childBytes, `${key} acceptance manifest`);
  assertEqual(child.status, 'completed', `${key} acceptance manifest status`);
  assertEqual(child.project, 'capture-workbench', `${key} acceptance manifest project`);
  const childErrors = child.errors;
  if (!Array.isArray(childErrors) || childErrors.length !== 0) {
    throw new Error(`${key} acceptance manifest must contain no errors.`);
  }
  const childCleanup = recordField(child, 'cleanup');
  assertCleanup(childCleanup, `${key}.cleanup`);
  const childFixture = recordField(child, 'fixture');
  assertDigestEqual(childFixture.sha256, expectedSourceSha256, `${key}.fixture.sha256`);
  const childEvidence = recordField(child, 'evidence');
  assertDigestEqual(
    childEvidence.sourceSha256,
    expectedSourceSha256,
    `${key}.evidence.sourceSha256`,
  );
  assertDigestEqual(
    childEvidence.importedSourceSha256,
    expectedSourceSha256,
    `${key}.evidence.importedSourceSha256`,
  );
  assertDigestEqual(
    childEvidence.runtimeArtifactSha256,
    PHASE1_FINAL_IDENTITY.runtimeArtifactSha256,
    `${key}.evidence.runtimeArtifactSha256`,
  );
  assertDigestEqual(
    childEvidence.contractSetSha256,
    PHASE1_FINAL_IDENTITY.contractSetSha256,
    `${key}.evidence.contractSetSha256`,
  );
  assertDigestEqual(
    childEvidence.workerArchiveSha256,
    PHASE1_FINAL_IDENTITY.ocrWorkerArchiveSha256,
    `${key}.evidence.workerArchiveSha256`,
  );
  assertDigestEqual(
    childEvidence.workerExecutableSha256,
    PHASE1_FINAL_IDENTITY.ocrWorkerExecutableSha256,
    `${key}.evidence.workerExecutableSha256`,
  );
  assertEqual(
    childEvidence.authenticatedRuntimePreflight,
    PHASE1_FINAL_IDENTITY.authenticatedRuntimePreflight,
    `${key}.evidence.authenticatedRuntimePreflight`,
  );
  assertEqual(childEvidence.uiGpuBeforeImport, true, `${key}.evidence.uiGpuBeforeImport`);
  assertEqual(childEvidence.expectedAnchorCount, PHASE1_FINAL_IDENTITY.expectedAnchorCount, `${key}.evidence.expectedAnchorCount`);
  assertEqual(childEvidence.matchedAnchorCount, PHASE1_FINAL_IDENTITY.expectedAnchorCount, `${key}.evidence.matchedAnchorCount`);
  if (pdf) {
    const childPageScope = recordField(childEvidence, 'pdfPageScope');
    assertEqual(
      childPageScope.sourcePageCount,
      PHASE1_FINAL_IDENTITY.pdfSourcePageCount,
      `${key}.evidence.pdfPageScope.sourcePageCount`,
    );
    assertPageList(
      childPageScope.requestedPageNumbers,
      [1],
      `${key}.evidence.pdfPageScope.requestedPageNumbers`,
    );
    assertPageList(
      childPageScope.processedPageNumbers,
      [1],
      `${key}.evidence.pdfPageScope.processedPageNumbers`,
    );
  }

  const common: Phase1JourneyEvidence = {
    runId: requiredString(journey.runId, `${key}.runId`),
    sourceSha256,
    importedSourceSha256,
    acceptanceManifestSha256,
    acceptanceManifestPath: acceptanceManifestPath.replaceAll('\\', '/'),
    authenticatedRuntimePreflight: 'gpu-dml',
    uiGpuBeforeImport: true,
    expectedAnchorCount: 1,
    matchedAnchorCount: 1,
    cleanup: trueCleanup(),
  };
  if (!pdf) return common;

  const pageScope = recordField(journey, 'pageScope');
  assertEqual(pageScope.sourcePageCount, PHASE1_FINAL_IDENTITY.pdfSourcePageCount, `${key}.pageScope.sourcePageCount`);
  assertPageList(pageScope.requestedPageNumbers, [1], `${key}.pageScope.requestedPageNumbers`);
  assertPageList(pageScope.processedPageNumbers, [1], `${key}.pageScope.processedPageNumbers`);
  assertPageList(pageScope.uiRawPageNumbers, [1], `${key}.pageScope.uiRawPageNumbers`);
  assertPageList(pageScope.uiStructuredPageNumbers, [1], `${key}.pageScope.uiStructuredPageNumbers`);
  return {
    ...common,
    pageScope: {
      sourcePageCount: 46,
      requestedPageNumbers: [1],
      processedPageNumbers: [1],
      uiRawPageNumbers: [1],
      uiStructuredPageNumbers: [1],
    },
  };
}

function trueCleanup(): Phase1CleanupEvidence {
  return {
    app: true,
    sidecar: true,
    cdpPort: true,
    temporaryAppData: true,
    ownedPids: true,
    ownedListeners: true,
    ownedWorkers: true,
  };
}

function assertCleanup(value: Record<string, unknown>, label: string): void {
  for (const key of [
    'app',
    'sidecar',
    'cdpPort',
    'temporaryAppData',
    'ownedPids',
    'ownedListeners',
    'ownedWorkers',
  ]) {
    assertEqual(value[key], true, `${label}.${key}`);
  }
}

function assertPageList(value: unknown, expected: readonly [1], label: string): void {
  if (!Array.isArray(value) || value.length !== expected.length || value[0] !== expected[0]) {
    throw new Error(`${label} must equal [1].`);
  }
}

function relativeAggregatePath(value: unknown, root: string, label: string): string {
  const candidate = requiredString(value, label);
  if (isAbsolute(candidate) || !SAFE_RELATIVE_PATH.test(candidate)) {
    throw new Error(`${label} must be a safe relative path.`);
  }
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, candidate);
  const descendant = relative(resolvedRoot, resolvedPath);
  if (
    !descendant ||
    descendant.startsWith('..') ||
    isAbsolute(descendant)
  ) {
    throw new Error(`${label} escaped the producer evidence root.`);
  }
  return descendant;
}

async function readRequiredFile(path: string, label: string): Promise<Buffer> {
  const details = await stat(path).catch(() => undefined);
  if (!details?.isFile() || details.size === 0) {
    throw new Error(`${label} is missing or empty: ${path}.`);
  }
  return readFile(path);
}

function parseJsonRecord(bytes: Uint8Array, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const nested = value[key];
  if (!isRecord(nested)) throw new Error(`Phase 1 final ${key} must be a JSON object.`);
  return nested;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is invalid.`);
  return value.trim();
}

function digestField(value: Record<string, unknown>, key: string, label: string): string {
  const digest = requiredString(value[key], label).toLowerCase();
  if (!SHA256_PATTERN.test(digest)) throw new Error(`${label} is not a SHA-256 digest.`);
  return digest;
}

function assertDigestEqual(value: unknown, expected: string, label: string): void {
  const digest = requiredString(value, label).toLowerCase();
  if (!SHA256_PATTERN.test(digest) || digest !== expected) {
    throw new Error(`${label} does not match the Phase 1 final identity.`);
  }
}

function assertEqual(value: unknown, expected: unknown, label: string): void {
  if (value !== expected) throw new Error(`${label} is not ${String(expected)}.`);
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
