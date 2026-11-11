import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  assertChecksumSidecar,
  CAPTURE_RUNTIME_CHECKSUM_FILE,
  CAPTURE_RUNTIME_FILE,
  CAPTURE_RUNTIME_RELEASE_ASSETS,
  CAPTURE_RUNTIME_VERSION,
  validateCaptureRuntimeReleaseManifest,
} from './install-capture-runtime.mts';
import {
  CAPTURE_DOCUMENT_SCHEMA_FILE,
  CAPTURE_DOCUMENT_SCHEMA_SHA256,
} from '../apps/cert-prep-desktop/scripts/package-qa/constants.mts';
import {
  assertCaptureRuntimeConsumerInventory,
  assertCaptureRuntimeConsumerVersions,
  readCaptureRuntimeConsumerInventory,
  type CaptureRuntimeContractSource,
} from './capture-runtime-version-check.mts';
import {
  assertCaptureRuntimeIdentity,
  parseCaptureRuntimeProbe,
  type CaptureRuntimeIdentityMode,
  type CaptureRuntimeIdentityReport,
  type CaptureRuntimeProbeIdentity,
} from './capture-runtime-identity.mts';

const CONSUMER_REPOSITORY = 'WodenWang820118/cert-prep';
const WORKFLOW_PATH = '.github/workflows/capture-candidate-gate.yml';
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

export type CaptureCandidateGateArguments = {
  readonly candidate: string;
  readonly candidateId: string;
  readonly candidateManifestSha256: string;
  readonly sourceCommit: string;
  readonly releaseVersion: string;
  readonly workflowRunId: number;
  readonly output: string;
  readonly skipChecks: boolean;
  readonly identityMode: CaptureRuntimeIdentityMode;
  readonly probeManifest?: string;
};

export type CaptureCandidateGateResult = {
  readonly schemaVersion: '1';
  readonly consumerRepository: typeof CONSUMER_REPOSITORY;
  readonly consumerCommit: string;
  readonly workflowPath: typeof WORKFLOW_PATH;
  readonly workflowRunId: number;
  readonly candidateId: string;
  readonly candidateManifestSha256: string;
  readonly verdict: 'passed';
  readonly checks: readonly {
    readonly name: string;
    readonly status: 'passed';
  }[];
  readonly startedAt: string;
  readonly completedAt: string;
  readonly identityMode?: CaptureRuntimeIdentityMode;
  readonly softChecks?: CaptureRuntimeIdentityReport['softChecks'];
};

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing required argument: ${name}.`);
  return value;
}

export function parseArguments(
  args: readonly string[],
): CaptureCandidateGateArguments {
  const values = new Map<string, string>();
  let skipChecks = false;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === '--skip-checks') {
      if (skipChecks) throw new Error('Arguments must be unique.');
      skipChecks = true;
      continue;
    }
    const value = args[index + 1];
    if (!name?.startsWith('--') || !value || values.has(name)) {
      throw new Error('Arguments must be unique --name value pairs.');
    }
    values.set(name, value);
    index += 1;
  }
  const candidateId = required(values, '--candidate-id');
  const candidateManifestSha256 = required(
    values,
    '--candidate-manifest-sha256',
  );
  const sourceCommit = required(values, '--source-commit');
  const workflowRunId = Number(required(values, '--workflow-run-id'));
  const identityMode = values.get('--identity-mode') ?? 'release';
  const probeManifest = values.get('--probe-manifest');
  if (!SHA256_PATTERN.test(candidateId))
    throw new Error('Candidate ID must be a lowercase SHA-256 digest.');
  if (!SHA256_PATTERN.test(candidateManifestSha256))
    throw new Error(
      'Candidate manifest digest must be a lowercase SHA-256 digest.',
    );
  if (!GIT_SHA_PATTERN.test(sourceCommit))
    throw new Error('Source commit must be a full lowercase Git SHA.');
  if (!Number.isSafeInteger(workflowRunId) || workflowRunId < 1)
    throw new Error('Workflow run ID must be a positive integer.');
  if (identityMode !== 'release' && identityMode !== 'local-probe')
    throw new Error('Identity mode must be release or local-probe.');
  if (identityMode === 'local-probe' && !probeManifest)
    throw new Error('Local-probe identity mode requires --probe-manifest.');
  if (identityMode === 'release' && probeManifest)
    throw new Error('--probe-manifest is only valid in local-probe mode.');
  return {
    candidate: resolve(required(values, '--candidate')),
    candidateId,
    candidateManifestSha256,
    sourceCommit,
    releaseVersion: required(values, '--release-version'),
    workflowRunId,
    output: resolve(required(values, '--output')),
    skipChecks,
    identityMode,
    ...(probeManifest ? { probeManifest: resolve(probeManifest) } : {}),
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonBytes(bytes: Uint8Array, label: string): Record<string, unknown> {
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>; }
  catch (error) { throw new Error(`${label} is not valid JSON.`, { cause: error }); }
}

async function requireRegularFile(path: string, label: string): Promise<void> {
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`${label} must be a regular file.`);
}

async function assertInstalledCandidatePackages(
  workspaceRoot: string,
  expectedVersion: string,
): Promise<void> {
  for (const packageName of [
    '@gx-capture/capture-workbench-ui',
    '@gx-capture/capture-runtime-client',
  ]) {
    const packageSegments = packageName.split('/');
    // pnpm links a transitive dependency next to its dependent inside the
    // virtual store, so resolve the UI package's real directory first.
    const workbenchRealPath = await realpath(
      join(workspaceRoot, 'node_modules', '@gx-capture', 'capture-workbench-ui'),
    ).catch(() => undefined);
    const manifestCandidates = [
      join(workspaceRoot, 'node_modules', ...packageSegments, 'package.json'),
      ...(workbenchRealPath
        ? [
            join(
              dirname(dirname(workbenchRealPath)),
              ...packageSegments,
              'package.json',
            ),
          ]
        : []),
    ];
    let packageManifest: { version?: unknown } | undefined;
    for (const manifestPath of manifestCandidates) {
      try {
        packageManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
          version?: unknown;
        };
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (!packageManifest) {
      throw new Error(`${packageName} candidate install manifest is missing.`);
    }
    if (packageManifest.version !== expectedVersion) {
      throw new Error(
        `${packageName} candidate install must be ${expectedVersion}, found ${String(packageManifest.version)}.`,
      );
    }
  }
}

export async function assertCandidateConsumerVersionContract(input: {
  readonly workspaceRoot: string;
  readonly expectedVersion: string;
  readonly contractSource: CaptureRuntimeContractSource;
}): Promise<void> {
  const report = assertCaptureRuntimeConsumerInventory(
    readCaptureRuntimeConsumerInventory(
      input.workspaceRoot,
      input.contractSource,
    ),
  );
  if (report.expectedRuntimeVersion !== input.expectedVersion) {
    throw new Error(
      `Candidate contract runtime identity must be ${input.expectedVersion}, found ${String(report.expectedRuntimeVersion)}.`,
    );
  }
  await assertInstalledCandidatePackages(
    input.workspaceRoot,
    input.expectedVersion,
  );
}

export async function assertConsumerVersionContract(
  expectedVersion: string,
  identityMode: CaptureRuntimeIdentityMode = 'release',
  contractSource?: CaptureRuntimeContractSource,
  workspaceRoot = resolve(import.meta.dirname, '..'),
): Promise<void> {
  if (identityMode === 'local-probe') return;
  const packageJson = JSON.parse(
    await readFile(join(workspaceRoot, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, unknown> };
  const workbenchDependency =
    packageJson.dependencies?.['@gx-capture/capture-workbench-ui'];
  // The release already pinned from public registries needs the pin
  // consistency check, plus the inventory whenever a candidate contract is
  // supplied; any other version must supply a candidate contract.
  const isPublishedPinPath =
    expectedVersion === CAPTURE_RUNTIME_VERSION &&
    process.env.CAPTURE_CANDIDATE_INSTALL !== '1' &&
    typeof workbenchDependency === 'string' &&
    !workbenchDependency.startsWith('file:');
  if (isPublishedPinPath) {
    assertCaptureRuntimeConsumerVersions(workspaceRoot);
    if (contractSource) {
      assertCaptureRuntimeConsumerInventory(
        readCaptureRuntimeConsumerInventory(workspaceRoot, contractSource),
      );
    }
    return;
  }
  if (!contractSource) {
    throw new Error(
      `Verified candidate consumer contract source is required for release ${expectedVersion}.`,
    );
  }
  await assertCandidateConsumerVersionContract({
    workspaceRoot,
    expectedVersion,
    contractSource,
  });
}

async function readJsonRecord(
  path: string,
  label: string,
): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${path}.`, { cause: error });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return raw as Record<string, unknown>;
}

async function loadProbeManifest(
  path: string,
): Promise<CaptureRuntimeProbeIdentity> {
  return parseCaptureRuntimeProbe(await readJsonRecord(path, 'Probe manifest'));
}

function containedWithin(root: string, path: string): boolean {
  const descendant = relative(root, path);
  return (
    descendant === '' ||
    (!descendant.startsWith('..') && !isAbsolute(descendant))
  );
}

async function assertPackagedArtifactBoundary(
  root: string,
  identityMode: CaptureRuntimeIdentityMode,
): Promise<{ readonly hasDirectUrlMetadata: boolean }> {
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new Error('Candidate must be an extracted package directory.');
  }
  const realRoot = await realpath(root);
  let hasDirectUrlMetadata = false;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (basename(path) === 'direct_url.json') hasDirectUrlMetadata = true;
      const details = await lstat(path);
      if (
        details.isSymbolicLink() ||
        (!details.isFile() && !details.isDirectory())
      ) {
        throw new Error(
          `Candidate packaged artifact boundary contains a link or non-file entry: ${path}.`,
        );
      }
      const realPath = await realpath(path);
      if (!containedWithin(realRoot, realPath)) {
        throw new Error(
          `Candidate packaged artifact resolves outside its archive boundary: ${path}.`,
        );
      }
      if (details.isDirectory()) await visit(path);
    }
  };
  for (const directoryName of [
    'runtime',
    'contracts',
    'package',
    'python',
    'crate',
    'checksums',
    'desktop',
  ]) {
    const directory = join(root, directoryName);
    const details = await lstat(directory).catch(() => undefined);
    if (
      !details &&
      ['runtime', 'contracts', 'package'].includes(directoryName)
    ) {
      throw new Error(
        `Candidate packaged artifact directory is missing: ${directory}.`,
      );
    }
    if (!details) continue;
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error(
        `Candidate packaged artifact directory is not a regular directory: ${directory}.`,
      );
    }
    if (!containedWithin(realRoot, await realpath(directory))) {
      throw new Error(
        `Candidate packaged artifact directory resolves outside its archive boundary: ${directory}.`,
      );
    }
    await visit(directory);
  }
  if (identityMode === 'release' && hasDirectUrlMetadata) {
    throw new Error('Release candidate contains local direct_url metadata.');
  }
  return { hasDirectUrlMetadata };
}

const COMBINED_CANDIDATE_ARTIFACT_DIRECTORIES = [
  'runtime',
  'package',
  'python',
  'crate',
  'desktop',
  'checksums',
  'contracts',
] as const;

const COMBINED_CANDIDATE_CONTROL_FILES = new Set([
  'candidate-manifest.json',
  'candidate-manifest.json.sha256',
  'release-ledger.json',
  'contract-impact.json',
]);

type CombinedCandidateArtifact = {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
};

/**
 * Complete declared artifact directory plus the producer-required artifact
 * subset. This receipt does not establish full D3 runtime or installer
 * readiness because the producer manifest only closes over files that exist.
 */
export type CandidateArtifactReceipt = Readonly<{
  readonly schemaVersion: '1';
  readonly candidateRoot: string;
  readonly candidateId: string;
  readonly candidateManifestSha256: string;
  readonly sourceCommit: string;
  readonly releaseVersion: string;
  readonly releaseMode: 'core-only' | 'model-enabled';
  readonly packageCandidateId: string;
  readonly runtimeCandidateId: string;
  /** Runtime contract-set identity; this is not the D3 acceptance hash. */
  readonly contractSetSha256: string;
  readonly artifacts: readonly CombinedCandidateArtifact[];
}>;

export type CandidateArtifactReceiptInput = Readonly<{
  readonly candidate: string;
  readonly candidateId: string;
  readonly candidateManifestSha256: string;
  readonly sourceCommit: string;
  readonly releaseVersion: string;
  readonly releaseMode: 'core-only' | 'model-enabled';
  readonly packageCandidateId: string;
  readonly runtimeCandidateId: string;
  /** Runtime contract-set identity; this is not the D3 acceptance hash. */
  readonly contractSetSha256: string;
}>;

function exactRecordKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new Error(`${label} fields are not canonical.`);
  }
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left).replaceAll('\\', '/');
  const normalizedRight = resolve(right).replaceAll('\\', '/');
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function canonicalCandidateRoot(
  candidate: string,
): Promise<{ readonly root: string; readonly realRoot: string }> {
  const root = resolve(candidate);
  const details = await lstat(root);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error('Candidate artifact root is not a regular directory.');
  }
  const parent = dirname(root);
  if (!sameFilesystemPath(parent, await realpath(parent))) {
    throw new Error(
      'Candidate artifact root has a symbolic-link or junction ancestor.',
    );
  }
  const realRoot = await realpath(root);
  if (!sameFilesystemPath(root, realRoot)) {
    throw new Error('Candidate artifact root is a symbolic link or junction.');
  }
  return { root, realRoot };
}

function assertCanonicalCandidateArtifactPath(path: string): void {
  if (
    !path ||
    path.includes('\\') ||
    isAbsolute(path) ||
    path.endsWith('/') ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    !COMBINED_CANDIDATE_ARTIFACT_DIRECTORIES.includes(
      path.split('/')[0] as (typeof COMBINED_CANDIDATE_ARTIFACT_DIRECTORIES)[number],
    )
  ) {
    throw new Error(`Candidate artifact path is not canonical: ${path}.`);
  }
}

async function assertCandidateRootShape(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  const expectedDirectories = new Set<string>(
    COMBINED_CANDIDATE_ARTIFACT_DIRECTORIES,
  );
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new Error(`Candidate root contains duplicate entry: ${entry.name}.`);
    }
    seen.add(entry.name);
    const path = join(root, entry.name);
    const details = await lstat(path);
    if (expectedDirectories.has(entry.name)) {
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new Error(
          `Candidate artifact directory is not a regular directory: ${path}.`,
        );
      }
      continue;
    }
    if (!COMBINED_CANDIDATE_CONTROL_FILES.has(entry.name)) {
      throw new Error(`Candidate root contains an unexpected entry: ${entry.name}.`);
    }
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error(
        `Candidate control entry is not a regular file: ${path}.`,
      );
    }
  }
  for (const directory of COMBINED_CANDIDATE_ARTIFACT_DIRECTORIES) {
    if (!seen.has(directory)) {
      throw new Error(`Candidate artifact directory is missing: ${directory}.`);
    }
  }
}

async function collectCombinedCandidateArtifactPaths(
  root: string,
  realRoot: string,
): Promise<readonly string[]> {
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const details = await lstat(path);
      if (
        details.isSymbolicLink() ||
        (!details.isFile() && !details.isDirectory())
      ) {
        throw new Error(
          `Candidate artifact inventory contains a link or non-file entry: ${path}.`,
        );
      }
      const actualPath = await realpath(path);
      if (!containedWithin(realRoot, actualPath)) {
        throw new Error(
          `Candidate artifact resolves outside its root: ${path}.`,
        );
      }
      if (details.isDirectory()) {
        await visit(path);
      } else {
        const relativePath = relative(root, path).replaceAll('\\', '/');
        assertCanonicalCandidateArtifactPath(relativePath);
        paths.push(relativePath);
      }
    }
  };
  for (const directory of COMBINED_CANDIDATE_ARTIFACT_DIRECTORIES) {
    await visit(join(root, directory));
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

async function readCandidateArtifact(
  root: string,
  realRoot: string,
  expected: CombinedCandidateArtifact,
): Promise<CombinedCandidateArtifact> {
  assertCanonicalCandidateArtifactPath(expected.path);
  const path = join(root, expected.path);
  const before = await lstat(path).catch(() => undefined);
  if (!before?.isFile() || before.isSymbolicLink()) {
    throw new Error(`Candidate artifact is missing or not a regular file: ${expected.path}.`);
  }
  const actualPath = await realpath(path);
  if (!containedWithin(realRoot, actualPath) || !sameFilesystemPath(path, actualPath)) {
    throw new Error(`Candidate artifact is a link or escaped its root: ${expected.path}.`);
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  const digest = sha256(bytes);
  if (
    !after.isFile() ||
    after.size !== before.size ||
    bytes.length !== expected.bytes ||
    digest !== expected.sha256
  ) {
    throw new Error(`Candidate artifact changed or mismatched: ${expected.path}.`);
  }
  return { path: expected.path, bytes: bytes.length, sha256: digest };
}

function manifestArtifact(
  value: unknown,
  index: number,
): CombinedCandidateArtifact {
  if (!isRecord(value)) {
    throw new Error(`Candidate manifest artifact ${index} is invalid.`);
  }
  exactRecordKeys(value, ['path', 'bytes', 'sha256'], `Candidate manifest artifact ${index}`);
  if (
    typeof value.path !== 'string' ||
    typeof value.bytes !== 'number' ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    typeof value.sha256 !== 'string' ||
    !SHA256_PATTERN.test(value.sha256)
  ) {
    throw new Error(`Candidate manifest artifact ${index} is invalid.`);
  }
  assertCanonicalCandidateArtifactPath(value.path);
  return { path: value.path, bytes: value.bytes, sha256: value.sha256 };
}

function ledgerArtifact(
  value: unknown,
  index: number,
): { readonly registry: string; readonly name: string; readonly sha256: string } {
  if (!isRecord(value)) {
    throw new Error(`Candidate release ledger artifact ${index} is invalid.`);
  }
  exactRecordKeys(value, ['name', 'registry', 'sha256'], `Candidate release ledger artifact ${index}`);
  if (
    typeof value.registry !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.sha256 !== 'string' ||
    !SHA256_PATTERN.test(value.sha256)
  ) {
    throw new Error(`Candidate release ledger artifact ${index} is invalid.`);
  }
  return { registry: value.registry, name: value.name, sha256: value.sha256 };
}

async function verifyCombinedCandidateRoot(
  input: CandidateArtifactReceiptInput,
): Promise<CandidateArtifactReceipt> {
  if (
    !SHA256_PATTERN.test(input.candidateId) ||
    !SHA256_PATTERN.test(input.candidateManifestSha256) ||
    !GIT_SHA_PATTERN.test(input.sourceCommit) ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(input.releaseVersion) ||
    (input.releaseMode !== 'core-only' &&
      input.releaseMode !== 'model-enabled') ||
    !SHA256_PATTERN.test(input.packageCandidateId) ||
    !SHA256_PATTERN.test(input.runtimeCandidateId) ||
    !SHA256_PATTERN.test(input.contractSetSha256)
  ) {
    throw new Error('Candidate artifact receipt identity is invalid.');
  }
  const { root, realRoot } = await canonicalCandidateRoot(input.candidate);
  await assertCandidateRootShape(root);
  await assertPackagedArtifactBoundary(root, 'release');
  const manifestPath = join(root, 'candidate-manifest.json');
  const manifestBytes = await readFile(manifestPath);
  const manifestSha256 = sha256(manifestBytes);
  if (manifestSha256 !== input.candidateManifestSha256) {
    throw new Error('Candidate manifest hash does not match the expected hash.');
  }
  const manifest = parseJsonBytes(manifestBytes, 'Candidate manifest');
  exactRecordKeys(
    manifest,
    [
      'artifacts',
      'candidateId',
      'contractImpact',
      'contractSetSha256',
      'documentSchemaVersion',
      'packageCandidateId',
      'releaseMode',
      'releaseVersion',
      'runtimeApiVersion',
      'runtimeCandidateId',
      'schemaVersion',
      'sourceCommit',
      'toolchains',
    ],
    'Candidate manifest',
  );
  if (
    manifest.schemaVersion !== '1' ||
    manifest.runtimeApiVersion !== '2.0' ||
    manifest.documentSchemaVersion !== '2' ||
    manifest.sourceCommit !== input.sourceCommit ||
    manifest.releaseVersion !== input.releaseVersion ||
    manifest.releaseMode !== input.releaseMode ||
    manifest.contractImpact !== null ||
    typeof manifest.candidateId !== 'string' ||
    manifest.candidateId !== input.candidateId ||
    typeof manifest.packageCandidateId !== 'string' ||
    manifest.packageCandidateId !== input.packageCandidateId ||
    typeof manifest.runtimeCandidateId !== 'string' ||
    manifest.runtimeCandidateId !== input.runtimeCandidateId ||
    typeof manifest.contractSetSha256 !== 'string' ||
    manifest.contractSetSha256 !== input.contractSetSha256 ||
    !isRecord(manifest.toolchains) ||
    Object.values(manifest.toolchains).some((value) => typeof value !== 'string') ||
    !Array.isArray(manifest.artifacts)
  ) {
    throw new Error('Candidate manifest identity is invalid.');
  }
  const { candidateId: manifestCandidateId, ...baseManifest } = manifest;
  if (
    sha256(Buffer.from(JSON.stringify(baseManifest))) !== manifestCandidateId
  ) {
    throw new Error('Candidate manifest candidateId derivation is invalid.');
  }
  const declaredArtifacts = manifest.artifacts.map(manifestArtifact);
  const declaredPaths = declaredArtifacts.map((artifact) => artifact.path);
  const sortedDeclaredPaths = [...declaredPaths].sort((left, right) =>
    left.localeCompare(right),
  );
  if (
    new Set(declaredPaths).size !== declaredPaths.length ||
    declaredPaths.some((path, index) => path !== sortedDeclaredPaths[index])
  ) {
    throw new Error('Candidate manifest artifact inventory is not canonical.');
  }
  const actualPaths = await collectCombinedCandidateArtifactPaths(root, realRoot);
  if (
    actualPaths.length !== declaredPaths.length ||
    actualPaths.some((path, index) => path !== declaredPaths[index])
  ) {
    throw new Error(
      'Candidate manifest artifact inventory does not match the candidate root.',
    );
  }
  const artifacts: CombinedCandidateArtifact[] = [];
  for (const artifact of declaredArtifacts) {
    artifacts.push(await readCandidateArtifact(root, realRoot, artifact));
  }

  const sidecar = (
    await readFile(join(root, 'candidate-manifest.json.sha256'), 'utf8')
  ).trim();
  if (sidecar !== `${manifestSha256}  candidate-manifest.json`) {
    throw new Error('Candidate manifest SHA-256 sidecar is invalid.');
  }
  const ledger = parseJsonBytes(
    await readFile(join(root, 'release-ledger.json')),
    'Candidate release ledger',
  );
  exactRecordKeys(
    ledger,
    [
      'artifacts',
      'candidateId',
      'candidateManifestSha256',
      'releaseMode',
      'schemaSha256',
      'sourceCommit',
      'status',
      'version',
    ],
    'Candidate release ledger',
  );
  if (
    ledger.candidateId !== manifestCandidateId ||
    ledger.candidateManifestSha256 !== manifestSha256 ||
    ledger.sourceCommit !== input.sourceCommit ||
    ledger.version !== input.releaseVersion ||
    ledger.releaseMode !== manifest.releaseMode ||
    ledger.status !== 'candidate-verified' ||
    !Array.isArray(ledger.artifacts)
  ) {
    throw new Error('Candidate release ledger identity is invalid.');
  }
  const schemaArtifact = artifacts.find(
    (artifact) => artifact.path === 'runtime/capture-document-v2.schema.json',
  );
  if (!schemaArtifact) {
    throw new Error('Candidate runtime schema artifact is missing.');
  }
  if (ledger.schemaSha256 !== schemaArtifact.sha256) {
    throw new Error('Candidate release ledger schema digest is invalid.');
  }
  if (schemaArtifact.sha256 !== CAPTURE_DOCUMENT_SCHEMA_SHA256) {
    throw new Error(
      'Candidate runtime schema digest is not the pinned canonical schema.',
    );
  }
  const runtimeManifestArtifact = artifacts.find(
    (artifact) => artifact.path === 'runtime/capture-runtime-manifest.json',
  );
  if (!runtimeManifestArtifact) {
    throw new Error('Candidate runtime manifest artifact is missing.');
  }
  const runtimeManifest = parseJsonBytes(
    await readFile(join(root, runtimeManifestArtifact.path)),
    'Candidate Capture Runtime manifest',
  );
  if (
    runtimeManifest.runtimeVersion !== input.releaseVersion ||
    runtimeManifest.schemaFileName !== CAPTURE_DOCUMENT_SCHEMA_FILE ||
    runtimeManifest.schemaSha256 !== schemaArtifact.sha256
  ) {
    throw new Error('Candidate Capture Runtime manifest identity is invalid.');
  }
  const contractSnapshotArtifact = artifacts.find(
    (artifact) => artifact.path === 'contracts/contract-snapshot.json',
  );
  if (!contractSnapshotArtifact) {
    throw new Error('Candidate contract snapshot artifact is missing.');
  }
  const contractSnapshot = parseJsonBytes(
    await readFile(join(root, contractSnapshotArtifact.path)),
    'Candidate contract snapshot',
  );
  if (contractSnapshot.schemaVersion !== '1') {
    throw new Error('Candidate contract snapshot schema is unsupported.');
  }
  const expectedPackageNames = new Set([
    `gx-capture-capture-workbench-ui-${input.releaseVersion}.tgz`,
    `gx-capture-capture-runtime-client-${input.releaseVersion}.tgz`,
  ]);
  const packageArtifacts = artifacts.filter((artifact) =>
    /^package\/[^/]+\.tgz$/u.test(artifact.path),
  );
  if (
    packageArtifacts.length !== expectedPackageNames.size ||
    packageArtifacts.some(
      (artifact) => !expectedPackageNames.has(basename(artifact.path)),
    )
  ) {
    throw new Error('Candidate npm artifact inventory is incomplete.');
  }
  const escapedReleaseVersion = input.releaseVersion.replace(
    /[.*+?^${}()|[\]\\]/gu,
    '\\$&',
  );
  const pythonArtifacts = artifacts.filter((artifact) =>
    new RegExp(
      `^python\\/capture_runtime_client-${escapedReleaseVersion}(?:-[^/]+)?\\.(?:whl|tar\\.gz)$`,
      'u',
    ).test(artifact.path),
  );
  if (pythonArtifacts.length === 0) {
    throw new Error('Candidate Python artifact inventory is incomplete.');
  }
  const cratePath = `crate/capture-sidecar-launcher-${input.releaseVersion}.crate`;
  const crateArtifacts = artifacts.filter((artifact) => artifact.path === cratePath);
  if (crateArtifacts.length !== 1) {
    throw new Error('Candidate Cargo artifact inventory is incomplete.');
  }
  const expectedRegistryArtifacts = [
    ...packageArtifacts,
    ...pythonArtifacts,
    ...crateArtifacts,
  ];
  const expectedLedgerArtifacts = expectedRegistryArtifacts.map((artifact) => {
    const [registryDirectory, name] = artifact.path.split('/');
    return {
      registry:
        registryDirectory === 'package'
          ? 'npm'
          : registryDirectory === 'python'
            ? 'pypi'
            : 'crates.io',
      name,
      sha256: artifact.sha256,
    };
  });
  const declaredLedgerArtifacts = ledger.artifacts.map(ledgerArtifact);
  const ledgerArtifactKey = (artifact: {
    readonly registry: string;
    readonly name: string;
    readonly sha256: string;
  }): string => `${artifact.registry}\u0000${artifact.name}\u0000${artifact.sha256}`;
  const expectedLedgerKeys = new Set(expectedLedgerArtifacts.map(ledgerArtifactKey));
  const declaredLedgerKeys = declaredLedgerArtifacts.map(ledgerArtifactKey);
  if (
    declaredLedgerArtifacts.length !== expectedLedgerArtifacts.length ||
    expectedLedgerKeys.size !== expectedLedgerArtifacts.length ||
    new Set(declaredLedgerKeys).size !== declaredLedgerKeys.length ||
    declaredLedgerKeys.some((key) => !expectedLedgerKeys.has(key))
  ) {
    throw new Error('Candidate release ledger artifact inventory is incomplete.');
  }
  for (const artifact of expectedRegistryArtifacts) {
    const name = basename(artifact.path);
    const checksumPath = `checksums/${name}.sha256`;
    const checksumArtifact = artifacts.find((entry) => entry.path === checksumPath);
    if (!checksumArtifact) {
      throw new Error(`Candidate checksum inventory is missing: ${checksumPath}.`);
    }
    const checksumText = (
      await readFile(join(root, checksumPath), 'utf8')
    ).trim();
    if (checksumText !== `${artifact.sha256}  ${name}`) {
      throw new Error(`Candidate checksum record is invalid: ${name}.`);
    }
  }
  const contractArtifact = artifacts.find(
    (artifact) => artifact.path === 'contracts/contract-set.json',
  );
  const contractDigestArtifact = artifacts.find(
    (artifact) => artifact.path === 'contracts/contract-set.sha256',
  );
  if (!contractArtifact || !contractDigestArtifact) {
    throw new Error('Candidate contract-set artifacts are missing.');
  }
  const contractBytes = await readFile(join(root, contractArtifact.path));
  const contractSetSha256 = sha256(contractBytes);
  const declaredContractSha256 = (
    await readFile(join(root, contractDigestArtifact.path), 'utf8')
  ).trim();
  if (
    contractSetSha256 !== manifest.contractSetSha256 ||
    declaredContractSha256 !== contractSetSha256
  ) {
    throw new Error('Candidate runtime contract-set identity is invalid.');
  }
  const frozenArtifacts = Object.freeze(
    artifacts.map((artifact) => Object.freeze({ ...artifact })),
  );
  return Object.freeze({
    schemaVersion: '1',
    candidateRoot: root,
    candidateId: manifestCandidateId,
    candidateManifestSha256: manifestSha256,
    sourceCommit: input.sourceCommit,
    releaseVersion: input.releaseVersion,
    releaseMode: input.releaseMode,
    packageCandidateId: manifest.packageCandidateId,
    runtimeCandidateId: manifest.runtimeCandidateId,
    contractSetSha256,
    artifacts: frozenArtifacts,
  });
}

export async function verifyCandidateArtifactReceipt(
  input: CandidateArtifactReceiptInput,
): Promise<CandidateArtifactReceipt> {
  return verifyCombinedCandidateRoot(input);
}

export async function reverifyCandidateArtifactReceipt(
  receipt: CandidateArtifactReceipt,
): Promise<void> {
  if (receipt.schemaVersion !== '1') {
    throw new Error('Candidate artifact receipt schema is unsupported.');
  }
  const current = await verifyCombinedCandidateRoot({
    candidate: receipt.candidateRoot,
    candidateId: receipt.candidateId,
    candidateManifestSha256: receipt.candidateManifestSha256,
    sourceCommit: receipt.sourceCommit,
    releaseVersion: receipt.releaseVersion,
    releaseMode: receipt.releaseMode,
    packageCandidateId: receipt.packageCandidateId,
    runtimeCandidateId: receipt.runtimeCandidateId,
    contractSetSha256: receipt.contractSetSha256,
  });
  if (
    current.releaseMode !== receipt.releaseMode ||
    current.packageCandidateId !== receipt.packageCandidateId ||
    current.runtimeCandidateId !== receipt.runtimeCandidateId ||
    current.contractSetSha256 !== receipt.contractSetSha256 ||
    current.artifacts.length !== receipt.artifacts.length ||
    current.artifacts.some(
      (artifact, index) =>
        artifact.path !== receipt.artifacts[index].path ||
        artifact.bytes !== receipt.artifacts[index].bytes ||
        artifact.sha256 !== receipt.artifacts[index].sha256,
    )
  ) {
    throw new Error('Candidate artifact receipt no longer matches its root.');
  }
}

async function loadContractIdentity(
  candidateRoot: string,
  candidateManifest: Record<string, unknown>,
): Promise<{
  readonly contractSetSha256: string;
  readonly ocrProjectionSchemaVersion: '3';
  readonly contractSource: CaptureRuntimeContractSource;
}> {
  const contractPath = join(candidateRoot, 'contracts', 'contract-set.json');
  const contractBytes = await readFile(contractPath).catch((error: unknown) => {
    throw new Error(
      `Candidate contract set is not readable: ${contractPath}.`,
      {
        cause: error,
      },
    );
  });
  const contractSetSha256 = sha256(contractBytes);
  const declared = candidateManifest.contractSetSha256;
  if (
    typeof declared !== 'string' ||
    !SHA256_PATTERN.test(declared) ||
    declared !== contractSetSha256
  ) {
    throw new Error(
      'Candidate manifest contract-set SHA-256 does not match the packaged contract set.',
    );
  }
  const declaredFile = (
    await readFile(
      join(candidateRoot, 'contracts', 'contract-set.sha256'),
      'utf8',
    ).catch((error: unknown) => {
      throw new Error(
        `Candidate contract-set SHA-256 file is not readable: ${join(candidateRoot, 'contracts', 'contract-set.sha256')}.`,
        { cause: error },
      );
    })
  ).trim();
  if (declaredFile !== contractSetSha256) {
    throw new Error(
      'Candidate contract-set SHA-256 file does not match its bytes.',
    );
  }
  const contractSet = await readJsonRecord(
    contractPath,
    'Candidate contract set',
  );
  const operations = Array.isArray(contractSet.operations)
    ? contractSet.operations
    : [];
  const ocrOperation = operations.find(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).method === 'GET' &&
      (value as Record<string, unknown>).path ===
        '/v2/captures/{capture_id}/ocr',
  ) as Record<string, unknown> | undefined;
  if (ocrOperation?.responseSchema !== 'CaptureOcrProjectionV3') {
    throw new Error(
      'Candidate contract set does not expose the CaptureOcrProjectionV3 schema.',
    );
  }
  const schemas = Array.isArray(contractSet.schemas)
    ? contractSet.schemas.filter(isRecord)
    : [];
  const projectionSchemas = schemas.filter(
    (schema) => schema.name === 'CaptureOcrProjectionV3',
  );
  if (projectionSchemas.length !== 1) {
    throw new Error(
      'Candidate contract set must declare exactly one CaptureOcrProjectionV3 schema.',
    );
  }
  const projectionProperties = isRecord(projectionSchemas[0].schema)
    ? projectionSchemas[0].schema.properties
    : undefined;
  const projectionSchemaVersion = isRecord(projectionProperties)
    ? isRecord(projectionProperties.schemaVersion)
      ? projectionProperties.schemaVersion.const
      : undefined
    : undefined;
  if (projectionSchemaVersion !== '3') {
    throw new Error(
      `Candidate CaptureOcrProjectionV3 schema version must be 3, found ${String(projectionSchemaVersion)}.`,
    );
  }
  return {
    contractSetSha256,
    ocrProjectionSchemaVersion: '3',
    contractSource: {
      source: 'candidate/contracts/contract-set.json',
      bytes: contractBytes,
      declaredSha256: contractSetSha256,
      ...(typeof candidateManifest.releaseVersion === 'string'
        ? { runtimeVersion: candidateManifest.releaseVersion }
        : {}),
    },
  };
}

async function loadCandidateWorker(
  candidateRoot: string,
  expectedRuntimeVersion: string,
  required: boolean,
  strictRuntimeVersion: boolean,
): Promise<
  | {
      readonly fileName: string;
      readonly sha256: string;
      readonly bytes: number;
    }
  | undefined
> {
  const runtimeRoot = join(candidateRoot, 'runtime');
  let catalogPath: string;
  try {
    await stat(join(runtimeRoot, 'capture-engine-catalog.json'));
    catalogPath = join(runtimeRoot, 'capture-engine-catalog.json');
  } catch {
    catalogPath = join(runtimeRoot, 'capture-engine-catalog.downloaded.json');
  }
  let catalog: Record<string, unknown>;
  try {
    catalog = await readJsonRecord(catalogPath, 'Candidate engine catalog');
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    if (!required && !(await stat(catalogPath).catch(() => undefined))) {
      return undefined;
    }
    throw error;
  }
  if (
    typeof catalog.runtimeVersion !== 'string' ||
    (strictRuntimeVersion && catalog.runtimeVersion !== expectedRuntimeVersion)
  ) {
    throw new Error('Candidate engine catalog runtimeVersion is invalid.');
  }
  const requirements = Array.isArray(catalog.requirements)
    ? catalog.requirements
    : [];
  const ocrRequirement = requirements.find(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).requirementId === 'windowsml-ocr',
  ) as Record<string, unknown> | undefined;
  const artifacts =
    ocrRequirement && Array.isArray(ocrRequirement.artifacts)
      ? ocrRequirement.artifacts
      : [];
  if (
    artifacts.length !== 1 ||
    typeof artifacts[0] !== 'object' ||
    artifacts[0] === null
  ) {
    if (required)
      throw new Error('Candidate engine catalog has no WindowsML OCR worker.');
    return undefined;
  }
  const artifact = artifacts[0] as Record<string, unknown>;
  const fileName = artifact.fileName;
  const expectedSha256 = artifact.sha256;
  const expectedBytes = artifact.bytes;
  if (
    typeof fileName !== 'string' ||
    !/^[A-Za-z0-9._-]+\.zip$/u.test(fileName) ||
    typeof expectedSha256 !== 'string' ||
    !SHA256_PATTERN.test(expectedSha256) ||
    typeof expectedBytes !== 'number' ||
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1
  ) {
    throw new Error(
      'Candidate engine catalog has an invalid WindowsML OCR worker.',
    );
  }
  const workerPath = join(runtimeRoot, fileName);
  const workerBytes = await readFile(workerPath).catch((error: unknown) => {
    throw new Error(`Candidate OCR worker is not readable: ${workerPath}.`, {
      cause: error,
    });
  });
  const workerSha256 = sha256(workerBytes);
  if (workerBytes.length !== expectedBytes || workerSha256 !== expectedSha256) {
    throw new Error('Candidate OCR worker does not match its engine catalog.');
  }
  return { fileName, sha256: workerSha256, bytes: workerBytes.length };
}

export async function verifyCandidate(
  input: Pick<
    CaptureCandidateGateArguments,
    | 'candidate'
    | 'candidateId'
    | 'candidateManifestSha256'
    | 'sourceCommit'
    | 'releaseVersion'
  > &
    Partial<
      Pick<CaptureCandidateGateArguments, 'identityMode' | 'probeManifest'>
    >,
): Promise<{
  readonly releaseMode: 'core-only' | 'model-enabled';
  readonly runtimeVersion: string;
  readonly identity: CaptureRuntimeIdentityReport;
  readonly contractSource: CaptureRuntimeContractSource;
}> {
  const identityMode = input.identityMode ?? 'release';
  if (identityMode === 'local-probe' && !input.probeManifest) {
    throw new Error('Local-probe identity mode requires --probe-manifest.');
  }
  const probe = input.probeManifest
    ? await loadProbeManifest(input.probeManifest)
    : undefined;
  if (probe && probe.sourceCommit !== input.sourceCommit) {
    throw new Error(
      'Producer probe source commit does not match the candidate input.',
    );
  }
  const boundary = await assertPackagedArtifactBoundary(
    input.candidate,
    identityMode,
  );
  const manifestPath = join(input.candidate, 'candidate-manifest.json');
  const manifestBytes = await readFile(manifestPath);
  if (sha256(manifestBytes) !== input.candidateManifestSha256) {
    throw new Error(
      'Candidate manifest digest does not match the dispatch input.',
    );
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<
    string,
    unknown
  >;
  if (
    manifest.candidateId !== input.candidateId ||
    manifest.sourceCommit !== input.sourceCommit ||
    (identityMode === 'release' &&
      manifest.releaseVersion !== input.releaseVersion)
  ) {
    throw new Error(
      'Candidate manifest identity does not match the dispatch input.',
    );
  }
  if (
    manifest.releaseMode !== 'core-only' &&
    manifest.releaseMode !== 'model-enabled'
  ) {
    throw new Error('Candidate release mode is invalid.');
  }

  const runtime = join(input.candidate, 'runtime');
  const runtimeManifestRaw = await readJsonRecord(
    join(runtime, 'capture-runtime-manifest.json'),
    'Candidate Capture Runtime manifest',
  );
  const runtimeVersion = runtimeManifestRaw.runtimeVersion;
  if (typeof runtimeVersion !== 'string' || !runtimeVersion) {
    throw new Error(
      'Candidate Capture Runtime manifest runtimeVersion is invalid.',
    );
  }
  const runtimeManifest = validateCaptureRuntimeReleaseManifest(
    runtimeManifestRaw,
    (identityMode === 'release' ? input.releaseVersion : runtimeVersion) as typeof CAPTURE_RUNTIME_VERSION,
  );
  for (const name of CAPTURE_RUNTIME_RELEASE_ASSETS) {
    await requireRegularFile(join(runtime, name), `Candidate runtime ${name}`);
  }
  await requireRegularFile(
    join(runtime, runtimeManifest.fileName),
    'Candidate runtime executable',
  );
  const executableBytes = await readFile(join(runtime, CAPTURE_RUNTIME_FILE));
  if (executableBytes.byteLength !== runtimeManifest.bytes) {
    throw new Error(
      'Candidate runtime executable byte count does not match its manifest.',
    );
  }
  if (sha256(executableBytes) !== runtimeManifest.sha256) {
    throw new Error(
      'Candidate runtime executable digest does not match its manifest.',
    );
  }
  // Candidates up to 0.9.0 also carry the executable's `.sha256` sidecar;
  // later ones do not (capture-workbench#278). A sidecar that is present must
  // agree with the manifest.
  const checksumSidecar = await readFile(
    join(runtime, CAPTURE_RUNTIME_CHECKSUM_FILE),
    'utf8',
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (checksumSidecar !== undefined) {
    assertChecksumSidecar(
      checksumSidecar,
      runtimeManifest.fileName,
      runtimeManifest.sha256,
      'Candidate runtime checksum sidecar does not match its manifest.',
    );
  }
  const schemaBytes = await readFile(
    join(runtime, runtimeManifest.schemaFileName),
  );
  if (runtimeManifest.schemaFileName !== 'capture-document-v2.schema.json') {
    throw new Error(
      `Capture runtime schemaFileName must be capture-document-v2.schema.json, found ${runtimeManifest.schemaFileName}.`,
    );
  }
  if (sha256(schemaBytes) !== runtimeManifest.schemaSha256) {
    throw new Error(
      'Candidate runtime schema digest does not match its manifest.',
    );
  }

  const packageNames = await readdir(join(input.candidate, 'package'));
  const packagePattern =
    identityMode === 'release'
      ? new RegExp(
          `^gx-capture-capture-workbench-ui-${input.releaseVersion.replaceAll('.', '\\.')}(?:-[^/]+)?\\.tgz$`,
          'u',
        )
      : /^gx-capture-capture-workbench-ui-\d+\.\d+\.\d+(?:-[^/]+)?\.tgz$/u;
  if (
    packageNames.some((name) => !name.endsWith('.tgz')) ||
    !packageNames.some((name) => packagePattern.test(name))
  ) {
    throw new Error(
      'Candidate does not contain only packaged Workbench archives.',
    );
  }
  const contract = await loadContractIdentity(input.candidate, manifest);
  const worker = await loadCandidateWorker(
    input.candidate,
    runtimeVersion,
    identityMode === 'local-probe' || manifest.releaseMode === 'model-enabled',
    identityMode === 'release',
  );
  const identity = assertCaptureRuntimeIdentity({
    mode: identityMode,
    probe,
    observed: {
      runtimeVersion,
      apiVersion: runtimeManifest.apiVersion,
      ocrProjectionSchemaVersion: contract.ocrProjectionSchemaVersion,
      contractSetSha256: contract.contractSetSha256,
      coreSha256: sha256(executableBytes),
      coreBytes: executableBytes.length,
      ...(worker
        ? { workerSha256: worker.sha256, workerBytes: worker.bytes }
        : {}),
    },
  });
  return {
    releaseMode: manifest.releaseMode,
    runtimeVersion,
    contractSource: contract.contractSource,
    identity: {
      ...identity,
      softChecks: [
        ...identity.softChecks,
        ...(identityMode === 'local-probe'
          ? [
              {
                name: 'local-direct-url-metadata',
                status: 'recorded' as const,
                observed: boundary.hasDirectUrlMetadata ? 'present' : 'absent',
              },
            ]
          : []),
      ],
    },
  };
}

function runNx(target: string): void {
  const corepackPath = resolve(
    dirname(process.execPath),
    'node_modules/corepack/dist/corepack.js',
  );
  const result = spawnSync(
    process.execPath,
    [
      corepackPath,
      'pnpm',
      'nx',
      'run',
      target,
      '--skip-nx-cache',
      '--outputStyle=static',
    ],
    {
      cwd: resolve(import.meta.dirname, '..'),
      env: process.env,
      stdio: 'inherit',
      shell: false,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Consumer gate target failed: ${target}.`);
}

function currentCommit(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  if (result.status !== 0)
    throw new Error('Could not resolve the consumer commit.');
  const commit = result.stdout.trim();
  if (!GIT_SHA_PATTERN.test(commit))
    throw new Error('Consumer commit is invalid.');
  return commit;
}

export type CandidateGateDependencies = {
  readonly workspaceRoot?: string;
  readonly runNx?: (target: string) => void;
  readonly writeResult?: (
    path: string,
    result: CaptureCandidateGateResult,
  ) => Promise<void>;
  readonly consumerCommit?: string;
};

async function writeCandidateGateResult(
  path: string,
  result: CaptureCandidateGateResult,
): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

export async function runCandidateGate(
  input: CaptureCandidateGateArguments,
  dependencies: CandidateGateDependencies = {},
): Promise<CaptureCandidateGateResult> {
  const startedAt = new Date().toISOString();
  const workspaceRoot =
    dependencies.workspaceRoot ?? resolve(import.meta.dirname, '..');
  const candidate = await verifyCandidate(input);
  await assertConsumerVersionContract(
    candidate.runtimeVersion,
    input.identityMode,
    candidate.contractSource,
    workspaceRoot,
  );
  const checks: { name: string; status: 'passed' }[] = [
    { name: 'candidate-identity', status: 'passed' },
    { name: 'candidate-runtime-assets', status: 'passed' },
    { name: 'candidate-workbench-package', status: 'passed' },
    {
      name:
        input.identityMode === 'local-probe'
          ? 'consumer-version-lock-recorded-only'
          : 'consumer-version-lock',
      status: 'passed',
    },
  ];
  if (candidate.releaseMode === 'model-enabled') {
    const modelCatalog = join(
      input.candidate,
      'runtime',
      'capture-engine-catalog.json',
    );
    await requireRegularFile(modelCatalog, 'Model-enabled candidate catalog');
    checks.push({ name: 'model-enabled-catalog-present', status: 'passed' });
  }
  if (!input.skipChecks) {
    const invokeNx = dependencies.runNx ?? runNx;
    invokeNx('cert-prep-desktop:capture-runtime-consumer-test');
    checks.push({ name: 'capture-runtime-consumer-tests', status: 'passed' });
    invokeNx('cert-prep-backend:test');
    checks.push({ name: 'cert-prep-backend-tests', status: 'passed' });
    invokeNx('cert-prep-desktop:package-qa-test');
    checks.push({ name: 'cert-prep-desktop-package-qa', status: 'passed' });
  }
  const completedAt = new Date().toISOString();
  const result = createResult({
    consumerCommit: dependencies.consumerCommit ?? currentCommit(),
    workflowRunId: input.workflowRunId,
    candidateId: input.candidateId,
    candidateManifestSha256: input.candidateManifestSha256,
    startedAt,
    completedAt,
    checks,
    ...(input.identityMode === 'local-probe'
      ? {
          identityMode: input.identityMode,
          softChecks: candidate.identity.softChecks,
        }
      : {}),
  });
  if (dependencies.writeResult) {
    await dependencies.writeResult(input.output, result);
  }
  return result;
}

export function createResult(input: {
  readonly consumerCommit: string;
  readonly workflowRunId: number;
  readonly candidateId: string;
  readonly candidateManifestSha256: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly checks: readonly {
    readonly name: string;
    readonly status: 'passed';
  }[];
  readonly identityMode?: CaptureRuntimeIdentityMode;
  readonly softChecks?: CaptureRuntimeIdentityReport['softChecks'];
}): CaptureCandidateGateResult {
  return {
    schemaVersion: '1',
    consumerRepository: CONSUMER_REPOSITORY,
    consumerCommit: input.consumerCommit,
    workflowPath: WORKFLOW_PATH,
    workflowRunId: input.workflowRunId,
    candidateId: input.candidateId,
    candidateManifestSha256: input.candidateManifestSha256,
    verdict: 'passed',
    checks: input.checks,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    ...(input.identityMode
      ? {
          identityMode: input.identityMode,
          ...(input.softChecks ? { softChecks: input.softChecks } : {}),
        }
      : {}),
  };
}

async function main(): Promise<void> {
  const input = parseArguments(process.argv.slice(2));
  const result = await runCandidateGate(input, {
    writeResult: writeCandidateGateResult,
  });
  process.stdout.write(
    `Cert Prep consumer gate passed for candidate ${result.candidateId}.\n`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
