import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

import {
  validateRuntimeCandidateContent,
  type ValidatedRuntimeCandidateContent,
} from './capture-candidate-gate.mts';
import { createFreshProjectionArtifactExporter } from './capture-fresh-projection-artifact.mts';
import { OwnedProjectionProcessManager } from './capture-projection-process.mts';

const RUNTIME_VERSION = '0.4.2' as const;
const RUNTIME_CANDIDATE_ID =
  '21430d577fc765be01036b27999b224544d1065b703e514d05ddfc1f40a69447';
const RUNTIME_CANDIDATE_MANIFEST_SHA256 =
  '9ae8c68cbd02d529367d320a98611b8291fcc6d19e74019b75ab0a46cbd6cbae';
const PACKAGE_CANDIDATE_ID =
  'eefe5627e68b8b0342d5a44c3dbbc249f0a85ad1da5b07d67cb8bb938817ef78';
const RUNTIME_WHEEL_SHA256 =
  '147120b12185e1d69200e168552d0bf70706f3bf7ea09fefe07d56053e85bae3';
const RUNTIME_CRATE_SHA256 =
  '9e6543b243c24f5c6cf6e1af2b6862ac4e5c6d80fafb2d269530e0e205625104';
const CRATES_IO_INDEX_URL = 'https://github.com/rust-lang/crates.io-index';
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const LOCK_PATHS = {
  pnpm: 'pnpm-lock.yaml',
  python: 'apps/cert-prep-backend/uv.lock',
  cargo: 'apps/cert-prep-desktop/src-tauri/Cargo.lock',
} as const;

type CommandEcosystem = keyof typeof LOCK_PATHS;
type PackageEcosystem = 'npm' | 'python' | 'cargo';
type ProjectionPhase = 'A' | 'B';

export interface CaptureFreshProjectionInput {
  readonly sourceRoot: string;
  readonly runtimeCandidateRoot: string;
  readonly packageCandidateRoot: string;
  readonly outputRoot?: string;
}

interface ArtifactAuthority {
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly content?: Uint8Array;
}

interface NpmPackageAuthority extends ArtifactAuthority {
  readonly name:
    | '@gx-capture/capture-runtime-client'
    | '@gx-capture/capture-workbench-ui';
  readonly version: typeof RUNTIME_VERSION;
  readonly archive: string;
  readonly integrity: string;
  readonly packageManifest: Readonly<Record<string, unknown>>;
}

interface ProjectionAuthorities {
  readonly runtime: {
    readonly schemaVersion: '1';
    readonly candidateKind: 'runtime';
    readonly candidateId: string;
    readonly manifestSha256: string;
    readonly sourceCommit?: string;
    readonly runtimeVersion: typeof RUNTIME_VERSION;
    readonly packageCandidateId: string;
    readonly contractSetSha256: string;
    readonly wheel: ArtifactAuthority;
    readonly sdist: ArtifactAuthority;
    readonly crate: ArtifactAuthority;
  };
  readonly packages: {
    readonly schemaVersion: '1';
    readonly candidateKind: 'npm-package-set';
    readonly candidateId: string;
    readonly manifestSha256: string;
    readonly packageManifestSha256: string;
    readonly sourceCommit?: string;
    readonly runtimeVersion: typeof RUNTIME_VERSION;
    readonly contractSetSha256: string;
    readonly npmPackages: readonly NpmPackageAuthority[];
  };
}

interface SourceSnapshot {
  readonly trackedTreeSha256: string;
  readonly trackedFileCount: number;
  readonly head: string | null;
  readonly dirty: boolean | null;
  readonly statusSha256: string | null;
}

interface TreeSnapshot {
  readonly treeSha256: string;
  readonly fileCount: number;
}

interface RegistryAudit {
  readonly requestCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly requiredRouteCount: number;
  readonly coveredRouteCount: number;
  readonly auditSha256: string;
}

interface RegistryCluster {
  readonly endpoints: {
    readonly npm: string;
    readonly python: string;
    readonly cargo: string;
  };
  readonly ports: readonly [number, number, number] | readonly number[];
  preflight(): Promise<void>;
  audit(): RegistryAudit;
  close(): Promise<number>;
}

export interface ProjectionCommand {
  readonly phase: ProjectionPhase;
  readonly ecosystem: CommandEcosystem;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface CapturePackageResolution {
  readonly ecosystem: PackageEcosystem;
  readonly packageName: string;
  readonly version: string;
  readonly sourceKind:
    | 'registry'
    | 'file'
    | 'link'
    | 'path'
    | 'editable'
    | 'direct-url';
  readonly sha256: string;
  readonly source?: string;
  readonly realPath?: string;
  readonly directUrl?: boolean;
}

export interface FreshProjectionArtifactReceipt {
  readonly receiptSchemaVersion: '1';
  readonly evidenceKind: 'fresh-build-output';
  readonly artifactKind: 'cert-installer' | 'cert-package-candidate';
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly freshBuild: true;
  readonly installedAcceptanceProven: false;
  readonly sourceTrackedTreeSha256: string;
  readonly runtimeCandidateId: string;
  readonly packageCandidateId: string;
  readonly lockSetSha256: string;
  readonly runtime: {
    readonly candidateManifestSha256: string;
    readonly contractSetSha256: string;
    readonly runtime: { readonly fileName: string; readonly bytes: number; readonly sha256: string };
    readonly schema: { readonly fileName: string; readonly bytes: number; readonly sha256: string };
    readonly catalog: { readonly fileName: string; readonly bytes: number; readonly sha256: string };
    readonly ocrArchive: { readonly fileName: string; readonly bytes: number; readonly sha256: string };
    readonly ocrFilesManifest: { readonly fileName: string; readonly bytes: number; readonly sha256: string };
    readonly profile: { readonly path: string; readonly bytes: number; readonly sha256: string };
    readonly pythonWheel: { readonly fileName: string; readonly bytes: number; readonly sha256: string };
  };
  readonly packageCandidate: {
    readonly candidateManifestSha256: string;
    readonly packageManifestSha256: string;
    readonly contractSetSha256: string;
  };
  readonly backend: {
    readonly artifact: { readonly fileName: string; readonly bytes: number; readonly sha256: string };
    readonly embeddedCaptureRuntimeProvenanceSha256: string;
  };
  readonly installer: { readonly fileName: string; readonly bytes: number; readonly sha256: string };
  readonly extracted: {
    readonly captureRuntime: { readonly fileName: string; readonly bytes: number; readonly sha256: string };
    readonly captureRuntimeManifestSha256: string;
    readonly captureDocumentSchemaSha256: string;
    readonly backendRuntimeManifestSha256: string;
    readonly backendRuntimeArtifact: { readonly fileName: string; readonly bytes: number; readonly sha256: string };
    readonly embeddedCaptureRuntimeProvenanceSha256: string;
  };
  readonly extractor: {
    readonly authorityClass: 'local-pinned-hash';
    readonly version: '25.01';
    readonly sha256: string;
    readonly archiveType: 'Nsis';
  };
}

export interface FreshProjectionArtifactExportRequest {
  readonly projectionRoot: string;
  readonly outputRoot: string;
  readonly runtimeCandidateRoot: string;
  readonly packageCandidateRoot: string;
  readonly sourceTrackedTreeSha256: string;
  readonly runtimeCandidateId: string;
  readonly packageCandidateId: string;
  readonly lockSetSha256: string;
}

export type FreshProjectionArtifactExporter = (
  request: FreshProjectionArtifactExportRequest,
) => Promise<FreshProjectionArtifactReceipt | null>;

interface CaptureFreshProjectionDependencies {
  validateRuntimeContent(input: {
    readonly candidate: string;
    readonly candidateId: string;
    readonly candidateManifestSha256: string;
  }): Promise<ValidatedRuntimeCandidateContent>;
  loadAuthorities(input: Readonly<CaptureFreshProjectionInput>): Promise<ProjectionAuthorities>;
  createTempRoot(): Promise<string>;
  validateTempRoot(root: string, forbiddenRoots: readonly string[]): Promise<void>;
  snapshotSource(root: string): Promise<SourceSnapshot>;
  snapshotCandidate(root: string): Promise<TreeSnapshot>;
  copyTrackedSource(sourceRoot: string, destination: string): Promise<number>;
  applyOverlays(input: {
    readonly projectionRoot: string;
    readonly endpoints: RegistryCluster['endpoints'];
    readonly cacheRoot: string;
  }): Promise<void>;
  startRegistries(input: {
    readonly authorities: ProjectionAuthorities;
    readonly runtimeCandidateRoot: string;
    readonly packageCandidateRoot: string;
  }): Promise<RegistryCluster>;
  runCommand(command: ProjectionCommand): Promise<void>;
  collectResolutions(input: {
    readonly projectionRoot: string;
    readonly cacheRoot: string;
    readonly endpoints: RegistryCluster['endpoints'];
    readonly authorities: ProjectionAuthorities;
  }): Promise<readonly CapturePackageResolution[]>;
  closeOwnedChildren(): Promise<number>;
  assertListenersClosed(ports: readonly number[]): Promise<number>;
  removeTempRoot(root: string): Promise<void>;
  validateOutputRoot(root: string, forbiddenRoots: readonly string[]): Promise<void>;
  exportFreshArtifact?: FreshProjectionArtifactExporter;
}

export interface CaptureFreshProjectionManifest {
  readonly schemaVersion: '1';
  readonly scope: 'local-candidate-projection';
  readonly runtime: {
    readonly version: typeof RUNTIME_VERSION;
    readonly candidateId: string;
    readonly candidateManifestSha256: string;
    readonly packageCandidateId: string;
    readonly packageCandidateManifestSha256: string;
    readonly packageManifestSha256: string;
    readonly contractSetSha256: string;
    readonly runtimeSha256: string;
    readonly ocrArchiveSha256: string;
    readonly ocrExecutableSha256: string;
    readonly catalogSha256: string;
    readonly profileSha256: string;
    readonly wheelSha256: string;
    readonly sdistSha256: string;
    readonly crateSha256: string;
    readonly npmPackageSha256: readonly string[];
  };
  readonly checkout: {
    readonly sourceCommit: string | null;
    readonly packageSourceCommit: string | null;
    readonly headBefore: string | null;
    readonly headAfter: string | null;
    readonly dirtyBefore: boolean | null;
    readonly dirtyAfter: boolean | null;
    readonly statusBeforeSha256: string | null;
    readonly statusAfterSha256: string | null;
    readonly trackedTreeSha256: string;
    readonly trackedFileCount: number;
  };
  readonly candidates: {
    readonly runtimeTreeSha256: string;
    readonly runtimeFileCount: number;
    readonly packageTreeSha256: string;
    readonly packageFileCount: number;
  };
  readonly registries: {
    readonly ownedServerCount: 3;
    readonly requestCount: number;
    readonly acceptedRequestCount: number;
    readonly rejectedRequestCount: 0;
    readonly requiredRouteCount: number;
    readonly coveredRouteCount: number;
    readonly auditSha256: string;
  };
  readonly projections: {
    readonly sourceCopyFileCount: number;
    readonly generatedCommandCount: number;
    readonly replayCommandCount: number;
    readonly replayRegistryRequestCount: 0;
    readonly locksByteEqual: true;
    readonly pnpmLockSha256: string;
    readonly pythonLockSha256: string;
    readonly cargoLockSha256: string;
    readonly lockSetSha256: string;
    readonly captureResolutionCount: 4;
  };
  readonly artifactExport: {
    readonly freshArtifactExported: boolean;
    readonly installedAcceptanceProven: false;
    readonly artifactKind?: FreshProjectionArtifactReceipt['artifactKind'];
    readonly artifactBytes?: number;
    readonly artifactSha256?: string;
    readonly receiptSha256?: string;
  };
  readonly cleanup: {
    readonly ownedServerCount: number;
    readonly ownedChildCount: number;
    readonly remainingListenerCount: number;
    readonly tempRemoved: boolean;
    readonly sourceUnchanged: boolean;
    readonly runtimeCandidateUnchanged: boolean;
    readonly packageCandidateUnchanged: boolean;
  };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isContained(root: string, candidate: string): boolean {
  const descendant = relative(resolve(root), resolve(candidate));
  return descendant === '' || (!descendant.startsWith('..') && !isAbsolute(descendant));
}

function assertDigest(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${label} is not a lowercase SHA-256 digest.`);
}

function informationalCommit(value: string | null | undefined): string | null {
  return typeof value === 'string' && GIT_SHA_PATTERN.test(value) ? value : null;
}

function informationalDigest(value: string | null | undefined): string | null {
  return typeof value === 'string' && SHA256_PATTERN.test(value) ? value : null;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
}

function expectedNpmPackages(authorities: ProjectionAuthorities): readonly NpmPackageAuthority[] {
  const sorted = [...authorities.packages.npmPackages].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const names = sorted.map(({ name }) => name);
  if (
    JSON.stringify(names) !==
    JSON.stringify([
      '@gx-capture/capture-runtime-client',
      '@gx-capture/capture-workbench-ui',
    ])
  ) {
    throw new Error('Linked package candidate must contain the exact Capture npm package set.');
  }
  return sorted;
}

function assertAuthorities(
  authorities: ProjectionAuthorities,
  runtimeContent: ValidatedRuntimeCandidateContent,
): void {
  const runtime = authorities.runtime;
  const packages = authorities.packages;
  if (
    runtime.schemaVersion !== '1' ||
    runtime.candidateKind !== 'runtime' ||
    runtime.candidateId !== RUNTIME_CANDIDATE_ID ||
    runtime.manifestSha256 !== RUNTIME_CANDIDATE_MANIFEST_SHA256 ||
    runtime.runtimeVersion !== RUNTIME_VERSION ||
    runtime.packageCandidateId !== PACKAGE_CANDIDATE_ID
  ) {
    throw new Error('J30 runtime candidate authority drifted.');
  }
  if (
    packages.schemaVersion !== '1' ||
    packages.candidateKind !== 'npm-package-set' ||
    packages.candidateId !== runtime.packageCandidateId ||
    packages.runtimeVersion !== RUNTIME_VERSION
  ) {
    throw new Error('J30/J16 package candidate linkage drifted.');
  }
  if (
    runtime.contractSetSha256 !== packages.contractSetSha256 ||
    runtime.contractSetSha256 !== runtimeContent.contractSetSha256
  ) {
    throw new Error('J30/J16 contract-set linkage drifted.');
  }
  if (
    runtimeContent.candidateKind !== 'runtime' ||
    runtimeContent.candidateId !== runtime.candidateId ||
    runtimeContent.candidateManifestSha256 !== runtime.manifestSha256 ||
    runtimeContent.manifestSha256 !== runtime.manifestSha256 ||
    runtimeContent.runtimeVersion !== RUNTIME_VERSION
  ) {
    throw new Error('Validated J30 runtime content does not match its exact authority.');
  }
  if (
    runtimeContent.workerEntryPoint !== 'capture-engine-ocr.exe' ||
    runtimeContent.profilePath !== '_internal/capture_runtime/assets/ocr-profile.json' ||
    runtimeContent.profile.device !== 'windowsml-dml' ||
    runtimeContent.profile.model !== 'pp-ocrv6-medium-windowsml' ||
    runtimeContent.modelEntryCount !== 10
  ) {
    throw new Error('Validated runtime worker, profile, or model identity drifted.');
  }
  if (runtime.wheel.sha256 !== RUNTIME_WHEEL_SHA256) {
    throw new Error('J30 Python execution wheel drifted.');
  }
  if (runtime.crate.sha256 !== RUNTIME_CRATE_SHA256) {
    throw new Error('J30 Cargo execution crate drifted.');
  }
  for (const [label, artifact] of [
    ['J30 Python wheel', runtime.wheel],
    ['J30 Python sdist', runtime.sdist],
    ['J30 Cargo crate', runtime.crate],
  ] as const) {
    assertDigest(artifact.sha256, `${label} hash`);
    assertPositiveInteger(artifact.bytes, `${label} byte count`);
  }
  assertDigest(packages.manifestSha256, 'J16 candidate manifest hash');
  assertDigest(packages.packageManifestSha256, 'J16 package manifest hash');
  for (const artifact of expectedNpmPackages(authorities)) {
    if (artifact.version !== RUNTIME_VERSION || !artifact.integrity.startsWith('sha512-')) {
      throw new Error(`J16 npm package identity drifted: ${artifact.name}.`);
    }
    assertDigest(artifact.sha256, `${artifact.name} archive hash`);
    assertPositiveInteger(artifact.bytes, `${artifact.name} archive byte count`);
  }
}

function assertRegistryAudit(audit: RegistryAudit): void {
  assertDigest(audit.auditSha256, 'Registry request audit hash');
  if (
    audit.rejectedCount !== 0 ||
    audit.requiredRouteCount < 1 ||
    audit.coveredRouteCount !== audit.requiredRouteCount ||
    audit.acceptedCount !== audit.requestCount
  ) {
    throw new Error('Registry request audit is incomplete or contains an unknown request.');
  }
}

function expectedResolutionHashes(
  authorities: ProjectionAuthorities,
): ReadonlyMap<string, string> {
  const npm = expectedNpmPackages(authorities);
  const runtimeClient = npm[0];
  const workbenchUi = npm[1];
  if (!runtimeClient || !workbenchUi) {
    throw new Error('Linked package candidate is missing an expected npm package.');
  }
  return new Map([
    ['npm:@gx-capture/capture-runtime-client', runtimeClient.sha256],
    ['npm:@gx-capture/capture-workbench-ui', workbenchUi.sha256],
    ['python:capture-runtime-client', authorities.runtime.wheel.sha256],
    ['cargo:capture-sidecar-launcher', authorities.runtime.crate.sha256],
  ]);
}

function assertCaptureResolutions(
  resolutions: readonly CapturePackageResolution[],
  authorities: ProjectionAuthorities,
  forbiddenRoots: readonly string[],
  allowedRoots: readonly string[],
): void {
  const expected = expectedResolutionHashes(authorities);
  if (resolutions.length !== expected.size) {
    throw new Error('Fresh projection did not resolve the exact Capture package set.');
  }
  const observed = new Set<string>();
  for (const resolution of resolutions) {
    const key = `${resolution.ecosystem}:${resolution.packageName}`;
    const expectedHash = expected.get(key);
    if (!expectedHash || observed.has(key)) {
      throw new Error('Fresh projection contains an unexpected or duplicate Capture package resolution.');
    }
    observed.add(key);
    if (
      resolution.version !== RUNTIME_VERSION ||
      resolution.sourceKind !== 'registry' ||
      resolution.sha256 !== expectedHash ||
      resolution.directUrl === true ||
      (resolution.source !== undefined &&
        /(?:^|[=:])(file|link|path|editable|direct[_-]?url)(?:$|:)/iu.test(resolution.source))
    ) {
      const reasons = [
        ...(resolution.version !== RUNTIME_VERSION ? ['version'] : []),
        ...(resolution.sourceKind !== 'registry' ? ['source-kind'] : []),
        ...(resolution.sha256 !== expectedHash ? ['hash'] : []),
        ...(resolution.directUrl === true ? ['direct-url'] : []),
        ...(resolution.source !== undefined &&
        /(?:^|[=:])(file|link|path|editable|direct[_-]?url)(?:$|:)/iu.test(resolution.source)
          ? ['local-source']
          : []),
      ];
      throw new Error(
        `Capture package ${key} did not resolve from the exact registry bytes (${reasons.join(', ')}).`,
      );
    }
    const installedRealPath = resolution.realPath;
    if (
      installedRealPath &&
      (forbiddenRoots.some((root) => isContained(root, installedRealPath)) ||
        !allowedRoots.some((root) => isContained(root, installedRealPath)))
    ) {
      throw new Error(`Capture package ${key} resolves into a forbidden candidate or source tree.`);
    }
  }
}

function commandGraph(
  phase: ProjectionPhase,
  projectionRoot: string,
  cacheRoot: string,
): readonly ProjectionCommand[] {
  const pnpmArgs =
    phase === 'A'
      ? ['pnpm', 'install', '--no-frozen-lockfile', '--ignore-scripts', '--store-dir', join(cacheRoot, 'pnpm')]
      : ['pnpm', 'install', '--frozen-lockfile', '--offline', '--ignore-scripts', '--store-dir', join(cacheRoot, 'pnpm')];
  const pythonArgs =
    phase === 'A'
      ? ['sync', '--project', join(projectionRoot, 'apps/cert-prep-backend'), '--cache-dir', join(cacheRoot, 'uv')]
      : ['sync', '--project', join(projectionRoot, 'apps/cert-prep-backend'), '--frozen', '--offline', '--cache-dir', join(cacheRoot, 'uv')];
  const cargoArgs =
    phase === 'A'
      ? ['fetch', '--manifest-path', join(projectionRoot, 'apps/cert-prep-desktop/src-tauri/Cargo.toml')]
      : ['check', '--manifest-path', join(projectionRoot, 'apps/cert-prep-desktop/src-tauri/Cargo.toml'), '--locked', '--offline'];
  const cargoEnvironment = { CARGO_HOME: join(cacheRoot, 'cargo') };
  return [
    { phase, ecosystem: 'pnpm', command: 'corepack', args: pnpmArgs, cwd: projectionRoot, env: {} },
    { phase, ecosystem: 'python', command: 'uv', args: pythonArgs, cwd: projectionRoot, env: {} },
    { phase, ecosystem: 'cargo', command: 'cargo', args: cargoArgs, cwd: projectionRoot, env: cargoEnvironment },
  ];
}

async function readLocks(root: string): Promise<Record<CommandEcosystem, Buffer>> {
  const entries = await Promise.all(
    (Object.entries(LOCK_PATHS) as [CommandEcosystem, string][]).map(async ([ecosystem, path]) => [
      ecosystem,
      await readFile(join(root, path)),
    ] as const),
  );
  return Object.fromEntries(entries) as Record<CommandEcosystem, Buffer>;
}

async function copyLocks(from: string, to: string): Promise<void> {
  for (const path of Object.values(LOCK_PATHS)) {
    const destination = join(to, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(from, path), destination);
  }
}

function locksEqual(
  left: Readonly<Record<CommandEcosystem, Buffer>>,
  right: Readonly<Record<CommandEcosystem, Buffer>>,
): boolean {
  return (Object.keys(LOCK_PATHS) as CommandEcosystem[]).every((key) => left[key].equals(right[key]));
}

function assertSafeTempRoot(tempRoot: string, inputRoots: readonly string[]): void {
  const systemTemp = resolve(tmpdir());
  const resolvedTemp = resolve(tempRoot);
  if (
    resolvedTemp === systemTemp ||
    !isContained(systemTemp, resolvedTemp) ||
    inputRoots.some((root) => isContained(root, resolvedTemp) || isContained(resolvedTemp, root))
  ) {
    throw new Error('Projection temp root is outside the permitted OS temp boundary.');
  }
}

function sameSource(left: SourceSnapshot, right: SourceSnapshot): boolean {
  return (
    left.trackedFileCount === right.trackedFileCount &&
    left.trackedTreeSha256 === right.trackedTreeSha256
  );
}

function sameTree(left: TreeSnapshot, right: TreeSnapshot): boolean {
  return left.fileCount === right.fileCount && left.treeSha256 === right.treeSha256;
}

function validateArtifactReceipt(
  receipt: FreshProjectionArtifactReceipt,
  request: FreshProjectionArtifactExportRequest,
): string {
  if (
    receipt.evidenceKind !== 'fresh-build-output' ||
    receipt.freshBuild !== true ||
    !['cert-installer', 'cert-package-candidate'].includes(receipt.artifactKind) ||
    basename(receipt.fileName) !== receipt.fileName ||
    receipt.fileName.includes('..') ||
    !Number.isSafeInteger(receipt.bytes) ||
    receipt.bytes < 1 ||
    receipt.sourceTrackedTreeSha256 !== request.sourceTrackedTreeSha256 ||
    receipt.runtimeCandidateId !== request.runtimeCandidateId ||
    receipt.packageCandidateId !== request.packageCandidateId ||
    receipt.lockSetSha256 !== request.lockSetSha256
  ) {
    throw new Error('Fresh artifact export receipt is not sealed to projection B.');
  }
  assertDigest(receipt.sha256, 'Fresh artifact hash');
  if (
    receipt.receiptSchemaVersion !== '1' ||
    receipt.installedAcceptanceProven !== false ||
    receipt.artifactKind !== 'cert-installer'
  ) {
    throw new Error('Fresh artifact export receipt has an unsupported artifact contract.');
  }
  return sha256(canonicalJson(receipt));
}

async function verifyExportedArtifact(
  outputRoot: string,
  receipt: FreshProjectionArtifactReceipt,
): Promise<void> {
  const artifactPath = resolve(outputRoot, receipt.fileName);
  if (!isContained(outputRoot, artifactPath)) {
    throw new Error('Fresh artifact path escapes its validated output root.');
  }
  const details = await lstat(artifactPath).catch(() => undefined);
  if (!details?.isFile() || details.isSymbolicLink() || details.size !== receipt.bytes) {
    throw new Error('Fresh artifact export bytes do not match its sealed receipt.');
  }
  const outputRealPath = await realpath(outputRoot);
  const artifactRealPath = await realpath(artifactPath);
  if (
    !isContained(outputRealPath, artifactRealPath) ||
    (await hashFile(artifactRealPath)) !== receipt.sha256
  ) {
    throw new Error('Fresh artifact export bytes do not match its sealed receipt.');
  }
}

function assertPrivacySafeManifest(manifest: CaptureFreshProjectionManifest, forbidden: readonly string[]): void {
  const serialized = JSON.stringify(manifest);
  for (const path of forbidden) {
    if (path && serialized.toLocaleLowerCase().includes(resolve(path).toLocaleLowerCase())) {
      throw new Error('Projection manifest contains an absolute local path.');
    }
  }
  if (/bearer|authorization|token|raw[_-]?ocr|published|release[-_ ]claim/iu.test(serialized)) {
    throw new Error('Projection manifest contains prohibited private or overclaiming data.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(bytes: Uint8Array, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (!isRecord(value)) throw new Error('root is not an object');
    return value;
  } catch (error) {
    throw new Error(`${label} is not a JSON object.`, { cause: error });
  }
}

function stringField(record: Readonly<Record<string, unknown>>, name: string, label: string): string {
  const value = record[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} has an invalid ${name}.`);
  }
  return value;
}

function artifactEntries(
  manifest: Readonly<Record<string, unknown>>,
  label: string,
): readonly Record<string, unknown>[] {
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.some((entry) => !isRecord(entry))) {
    throw new Error(`${label} has an invalid artifact inventory.`);
  }
  return manifest.artifacts as Record<string, unknown>[];
}

function artifactEntry(
  entries: readonly Record<string, unknown>[],
  path: string,
  label: string,
): { readonly path: string; readonly bytes: number; readonly sha256: string } {
  const entry = entries.find((candidate) => candidate.path === path);
  if (
    !entry ||
    typeof entry.bytes !== 'number' ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes < 1 ||
    typeof entry.sha256 !== 'string' ||
    !SHA256_PATTERN.test(entry.sha256)
  ) {
    throw new Error(`${label} omits exact artifact ${path}.`);
  }
  return { path, bytes: entry.bytes, sha256: entry.sha256 };
}

async function readSealedArtifact(
  root: string,
  descriptor: { readonly path: string; readonly bytes: number; readonly sha256: string },
  label: string,
): Promise<Buffer> {
  const path = resolve(root, descriptor.path);
  if (!isContained(root, path)) throw new Error(`${label} path escapes its candidate root.`);
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file.`);
  }
  const resolvedRoot = await realpath(root);
  const resolvedPath = await realpath(path);
  if (!isContained(resolvedRoot, resolvedPath)) {
    throw new Error(`${label} resolves outside its candidate root.`);
  }
  const bytes = await readFile(path);
  if (bytes.length !== descriptor.bytes || sha256(bytes) !== descriptor.sha256) {
    throw new Error(`${label} bytes drifted from its immutable manifest.`);
  }
  return bytes;
}

function tarString(bytes: Buffer, offset: number, length: number): string {
  const end = bytes.indexOf(0, offset);
  const limit = end >= offset && end < offset + length ? end : offset + length;
  return bytes.subarray(offset, limit).toString('utf8').trim();
}

function readTarGzipEntry(archive: Uint8Array, expectedPath: string, label: string): Buffer {
  const bytes = gunzipSync(archive);
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = tarString(header, 124, 12).replaceAll('\0', '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${label} has an invalid tar entry.`);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > bytes.length) throw new Error(`${label} tar entry is truncated.`);
    if (path === expectedPath) return bytes.subarray(contentStart, contentEnd);
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${label} omits ${expectedPath}.`);
}

async function assertDigestSidecar(root: string, fileName: string, digest: string): Promise<void> {
  const sidecarPath = join(root, `${fileName}.sha256`);
  const details = await lstat(sidecarPath);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${fileName} digest sidecar is not a regular file.`);
  }
  const declared = (await readFile(sidecarPath, 'utf8')).trim().split(/\s+/u)[0];
  if (declared !== digest) throw new Error(`${fileName} digest sidecar drifted.`);
}

async function loadProjectionAuthorities(
  input: Readonly<CaptureFreshProjectionInput>,
): Promise<ProjectionAuthorities> {
  for (const [root, label] of [
    [input.runtimeCandidateRoot, 'J30 runtime candidate'],
    [input.packageCandidateRoot, 'J16 package candidate'],
  ] as const) {
    const details = await lstat(root);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error(`${label} root is not a regular directory.`);
    }
  }

  const runtimeManifestBytes = await readFile(join(input.runtimeCandidateRoot, 'candidate-manifest.json'));
  const runtimeManifestSha256 = sha256(runtimeManifestBytes);
  if (runtimeManifestSha256 !== RUNTIME_CANDIDATE_MANIFEST_SHA256) {
    throw new Error('J30 runtime candidate manifest hash drifted.');
  }
  await assertDigestSidecar(
    input.runtimeCandidateRoot,
    'candidate-manifest.json',
    runtimeManifestSha256,
  );
  const runtimeManifest = parseJson(runtimeManifestBytes, 'J30 runtime candidate manifest');
  const runtimeCandidateId = stringField(runtimeManifest, 'candidateId', 'J30 runtime candidate manifest');
  const runtimeIdentityContent = { ...runtimeManifest };
  delete runtimeIdentityContent.candidateId;
  if (
    runtimeCandidateId !== RUNTIME_CANDIDATE_ID ||
    sha256(JSON.stringify(runtimeIdentityContent)) !== runtimeCandidateId
  ) {
    throw new Error('J30 runtime candidate ID derivation drifted.');
  }
  if (
    runtimeManifest.schemaVersion !== '1' ||
    runtimeManifest.candidateKind !== 'runtime' ||
    runtimeManifest.releaseVersion !== RUNTIME_VERSION
  ) {
    throw new Error('J30 runtime candidate identity drifted.');
  }
  const runtimeEntries = artifactEntries(runtimeManifest, 'J30 runtime candidate manifest');
  const runtimeArtifacts = {
    wheel: artifactEntry(
      runtimeEntries,
      'python/capture_runtime_client-0.4.2-py3-none-any.whl',
      'J30 runtime candidate manifest',
    ),
    sdist: artifactEntry(
      runtimeEntries,
      'python/capture_runtime_client-0.4.2.tar.gz',
      'J30 runtime candidate manifest',
    ),
    crate: artifactEntry(
      runtimeEntries,
      'crate/capture-sidecar-launcher-0.4.2.crate',
      'J30 runtime candidate manifest',
    ),
  };
  const [wheelBytes, sdistBytes, crateBytes] = await Promise.all([
    readSealedArtifact(input.runtimeCandidateRoot, runtimeArtifacts.wheel, 'J30 Python wheel'),
    readSealedArtifact(input.runtimeCandidateRoot, runtimeArtifacts.sdist, 'J30 Python sdist'),
    readSealedArtifact(input.runtimeCandidateRoot, runtimeArtifacts.crate, 'J30 Cargo crate'),
  ]);
  const sdistMetadata = readTarGzipEntry(
    sdistBytes,
    'capture_runtime_client-0.4.2/PKG-INFO',
    'J30 Python sdist',
  ).toString('utf8');
  if (!/^Name: capture-runtime-client$/mu.test(sdistMetadata) || !/^Version: 0\.4\.2$/mu.test(sdistMetadata)) {
    throw new Error('J30 Python package identity drifted.');
  }
  const crateManifest = readTarGzipEntry(
    crateBytes,
    'capture-sidecar-launcher-0.4.2/Cargo.toml',
    'J30 Cargo crate',
  ).toString('utf8');
  if (!/^name = "capture-sidecar-launcher"$/mu.test(crateManifest) || !/^version = "0\.4\.2"$/mu.test(crateManifest)) {
    throw new Error('J30 Cargo package identity drifted.');
  }

  const packageCandidateBytes = await readFile(join(input.packageCandidateRoot, 'candidate-manifest.json'));
  const packageCandidateManifestSha256 = sha256(packageCandidateBytes);
  await assertDigestSidecar(
    input.packageCandidateRoot,
    'candidate-manifest.json',
    packageCandidateManifestSha256,
  );
  const packageCandidate = parseJson(packageCandidateBytes, 'J16 package candidate manifest');
  const packageCandidateId = stringField(packageCandidate, 'candidateId', 'J16 package candidate manifest');
  const packageIdentityContent = { ...packageCandidate };
  delete packageIdentityContent.candidateId;
  if (
    packageCandidateId !== stringField(runtimeManifest, 'packageCandidateId', 'J30 runtime candidate manifest') ||
    sha256(JSON.stringify(packageIdentityContent)) !== packageCandidateId
  ) {
    throw new Error('J30/J16 package candidate linkage or ID derivation drifted.');
  }
  if (
    packageCandidate.schemaVersion !== '1' ||
    packageCandidate.candidateKind !== 'npm-package-set' ||
    packageCandidate.releaseVersion !== RUNTIME_VERSION
  ) {
    throw new Error('J16 package candidate identity drifted.');
  }
  const packageEntries = artifactEntries(packageCandidate, 'J16 package candidate manifest');
  const canonicalJ16Paths = [
    'contracts/contract-set.json',
    'contracts/contract-set.sha256',
    'contracts/contract-snapshot.json',
    'java-candidate-manifest.json',
    'maven/capture-runtime-client-0.4.2-sources.jar',
    'maven/capture-runtime-client-0.4.2.jar',
    'maven/capture-runtime-contract-set.sha256',
    'maven/pom.xml',
    'package-manifest.json',
    'package/gx-capture-capture-runtime-client-0.4.2.tgz',
    'package/gx-capture-capture-workbench-ui-0.4.2.tgz',
    'python/capture_runtime_client-0.4.2-py3-none-any.whl',
    'python/capture_runtime_client-0.4.2.tar.gz',
  ].sort();
  const observedJ16Paths = packageEntries
    .map((entry) => stringField(entry, 'path', 'J16 package candidate artifact'))
    .sort();
  if (JSON.stringify(observedJ16Paths) !== JSON.stringify(canonicalJ16Paths)) {
    throw new Error('J16 package candidate artifact inventory drifted.');
  }
  const sealedJ16Artifacts = new Map<string, Buffer>();
  for (const path of canonicalJ16Paths) {
    const descriptor = artifactEntry(packageEntries, path, 'J16 package candidate manifest');
    sealedJ16Artifacts.set(
      path,
      await readSealedArtifact(input.packageCandidateRoot, descriptor, `J16 artifact ${path}`),
    );
  }
  const packageManifestDescriptor = artifactEntry(
    packageEntries,
    'package-manifest.json',
    'J16 package candidate manifest',
  );
  const sealedPackageManifest = sealedJ16Artifacts.get('package-manifest.json');
  if (!sealedPackageManifest) throw new Error('J16 package manifest bytes are missing.');
  const packageManifestSha256 = sha256(sealedPackageManifest);
  if (
    packageManifestSha256 !== packageManifestDescriptor.sha256 ||
    packageManifestSha256 !== packageCandidate.packageManifestSha256
  ) {
    throw new Error('J16 package-manifest linkage drifted.');
  }
  await assertDigestSidecar(input.packageCandidateRoot, 'package-manifest.json', packageManifestSha256);
  const packageManifest = parseJson(
    sealedPackageManifest,
    'J16 package manifest',
  );
  if (
    packageManifest.schemaVersion !== '1' ||
    packageManifest.candidateKind !== 'npm-package-set' ||
    packageManifest.releaseVersion !== RUNTIME_VERSION ||
    !Array.isArray(packageManifest.packages) ||
    packageManifest.packages.some((entry) => !isRecord(entry))
  ) {
    throw new Error('J16 package manifest identity drifted.');
  }
  const npmPackages: NpmPackageAuthority[] = [];
  for (const packageRecord of packageManifest.packages as Record<string, unknown>[]) {
    const name = stringField(packageRecord, 'name', 'J16 npm package');
    if (name !== '@gx-capture/capture-runtime-client' && name !== '@gx-capture/capture-workbench-ui') {
      throw new Error('J16 package manifest contains an unexpected npm package.');
    }
    const archive = stringField(packageRecord, 'archive', `J16 npm package ${name}`);
    const descriptor = artifactEntry(packageEntries, archive, 'J16 package candidate manifest');
    const archiveBytes = sealedJ16Artifacts.get(archive);
    if (
      !archiveBytes ||
      packageRecord.bytes !== descriptor.bytes ||
      packageRecord.sha256 !== descriptor.sha256 ||
      typeof packageRecord.integrity !== 'string' ||
      packageRecord.integrity !==
        `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`
    ) {
      throw new Error(`J16 npm package ${name} linkage drifted.`);
    }
    const embeddedManifest = parseJson(
      readTarGzipEntry(archiveBytes, 'package/package.json', `J16 npm package ${name}`),
      `J16 npm package ${name} manifest`,
    );
    if (embeddedManifest.name !== name || embeddedManifest.version !== RUNTIME_VERSION) {
      throw new Error(`J16 npm archive identity drifted: ${name}.`);
    }
    if (
      name === '@gx-capture/capture-runtime-client' &&
      embeddedManifest.contractSetSha256 !== packageCandidate.contractSetSha256
    ) {
      throw new Error('J16 runtime client contract identity drifted.');
    }
    if (
      name === '@gx-capture/capture-workbench-ui' &&
      (!isRecord(embeddedManifest.dependencies) ||
        embeddedManifest.dependencies['@gx-capture/capture-runtime-client'] !== RUNTIME_VERSION)
    ) {
      throw new Error('J16 UI archive does not depend on the exact runtime client version.');
    }
    npmPackages.push({
      name,
      version: RUNTIME_VERSION,
      archive,
      fileName: basename(archive),
      bytes: descriptor.bytes,
      sha256: descriptor.sha256,
      integrity: packageRecord.integrity,
      content: archiveBytes,
      packageManifest: embeddedManifest,
    });
  }

  return {
    runtime: {
      schemaVersion: '1',
      candidateKind: 'runtime',
      candidateId: runtimeCandidateId,
      manifestSha256: runtimeManifestSha256,
      ...(typeof runtimeManifest.sourceCommit === 'string'
        ? { sourceCommit: runtimeManifest.sourceCommit }
        : {}),
      runtimeVersion: RUNTIME_VERSION,
      packageCandidateId,
      contractSetSha256: stringField(runtimeManifest, 'contractSetSha256', 'J30 runtime candidate manifest'),
      wheel: {
        fileName: basename(runtimeArtifacts.wheel.path),
        bytes: runtimeArtifacts.wheel.bytes,
        sha256: runtimeArtifacts.wheel.sha256,
        content: wheelBytes,
      },
      sdist: {
        fileName: basename(runtimeArtifacts.sdist.path),
        bytes: runtimeArtifacts.sdist.bytes,
        sha256: runtimeArtifacts.sdist.sha256,
        content: sdistBytes,
      },
      crate: {
        fileName: basename(runtimeArtifacts.crate.path),
        bytes: runtimeArtifacts.crate.bytes,
        sha256: runtimeArtifacts.crate.sha256,
        content: crateBytes,
      },
    },
    packages: {
      schemaVersion: '1',
      candidateKind: 'npm-package-set',
      candidateId: packageCandidateId,
      manifestSha256: packageCandidateManifestSha256,
      packageManifestSha256,
      ...(typeof packageCandidate.sourceCommit === 'string'
        ? { sourceCommit: packageCandidate.sourceCommit }
        : {}),
      runtimeVersion: RUNTIME_VERSION,
      contractSetSha256: stringField(
        packageCandidate,
        'contractSetSha256',
        'J16 package candidate manifest',
      ),
      npmPackages,
    },
  };
}

interface RegistryRoute {
  readonly id: string;
  readonly path: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly aliases?: readonly string[];
}

interface RegistryRequestObservation {
  readonly registry: 'npm' | 'python' | 'cargo';
  readonly method: string;
  readonly routeId: string;
  readonly accepted: boolean;
}

function sha1(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}

async function listenLoopback(
  registry: RegistryRequestObservation['registry'],
  routeFactory: (baseUrl: string) => readonly RegistryRoute[],
  observations: RegistryRequestObservation[],
): Promise<{
  readonly server: Server;
  readonly port: number;
  readonly baseUrl: string;
  readonly routes: readonly RegistryRoute[];
}> {
  let routes: readonly RegistryRoute[] = [];
  const server = createHttpServer((request, response) => {
    const method = request.method ?? 'UNKNOWN';
    let pathname = '/invalid-encoding';
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    } catch {
      // Retain a fixed non-sensitive sentinel and reject below.
    }
    const route = routes.find(
      (candidate) => candidate.path === pathname || candidate.aliases?.includes(pathname),
    );
    const accepted = (method === 'GET' || method === 'HEAD') && route !== undefined;
    observations.push({
      registry,
      method,
      routeId: route?.id ?? 'unknown',
      accepted,
    });
    if (!accepted || !route) {
      response.writeHead(method === 'GET' || method === 'HEAD' ? 404 : 405, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': route.contentType,
      'content-length': String(route.bytes.length),
      'cache-control': 'public, max-age=31536000, immutable',
    });
    response.end(method === 'HEAD' ? undefined : route.bytes);
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    throw new Error('Owned registry did not bind to an IPv4 loopback listener.');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  routes = routeFactory(baseUrl);
  return { server, port: address.port, baseUrl, routes };
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}

function cargoIndexRecord(crate: ArtifactAuthority): Record<string, unknown> {
  return {
    name: 'capture-sidecar-launcher',
    vers: RUNTIME_VERSION,
    deps: [
      {
        name: 'rand',
        req: '^0.8',
        features: [],
        optional: false,
        default_features: true,
        target: null,
        kind: 'normal',
        registry: CRATES_IO_INDEX_URL,
      },
      {
        name: 'serde',
        req: '^1',
        features: ['derive'],
        optional: false,
        default_features: true,
        target: null,
        kind: 'normal',
        registry: CRATES_IO_INDEX_URL,
      },
      {
        name: 'serde_json',
        req: '^1',
        features: [],
        optional: false,
        default_features: true,
        target: null,
        kind: 'normal',
        registry: CRATES_IO_INDEX_URL,
      },
      {
        name: 'sha2',
        req: '^0.10',
        features: [],
        optional: false,
        default_features: true,
        target: null,
        kind: 'normal',
        registry: CRATES_IO_INDEX_URL,
      },
      {
        name: 'windows-sys',
        req: '^0.61',
        features: [
          'Win32_Foundation',
          'Win32_Security',
          'Win32_System_Diagnostics_ToolHelp',
          'Win32_System_JobObjects',
          'Win32_System_SystemInformation',
          'Win32_System_Threading',
        ],
        optional: false,
        default_features: true,
        target: 'cfg(windows)',
        kind: 'normal',
        registry: CRATES_IO_INDEX_URL,
      },
    ],
    cksum: crate.sha256,
    features: {},
    yanked: false,
    links: null,
  };
}

function sealedAuthorityContent(artifact: ArtifactAuthority): Uint8Array {
  const content = artifact.content;
  if (!content || content.length !== artifact.bytes || sha256(content) !== artifact.sha256) {
    throw new Error(`Registry artifact ${artifact.fileName} is not sealed in memory.`);
  }
  return content;
}

async function startProjectionRegistries(input: {
  readonly authorities: ProjectionAuthorities;
  readonly runtimeCandidateRoot: string;
  readonly packageCandidateRoot: string;
}): Promise<RegistryCluster> {
  const observations: RegistryRequestObservation[] = [];
  const npmPackages = expectedNpmPackages(input.authorities);
  for (const artifact of [
    ...npmPackages,
    input.authorities.runtime.wheel,
    input.authorities.runtime.sdist,
    input.authorities.runtime.crate,
  ]) {
    sealedAuthorityContent(artifact);
  }

  const owned: Server[] = [];
  try {
    const npm = await listenLoopback(
      'npm',
      (baseUrl) =>
        npmPackages.flatMap((artifact) => {
          const tarballPath = `/tarballs/${artifact.fileName}`;
          const packageManifest = {
            ...artifact.packageManifest,
            name: artifact.name,
            version: RUNTIME_VERSION,
            dist: {
              tarball: `${baseUrl}${tarballPath}`,
              integrity: artifact.integrity,
              shasum: sha1(sealedAuthorityContent(artifact)),
            },
          };
          return [
            {
              id: `packument:${artifact.name}`,
              path: `/${artifact.name}`,
              aliases: [`/${encodeURIComponent(artifact.name)}`],
              contentType: 'application/vnd.npm.install-v1+json',
              bytes: Buffer.from(
                JSON.stringify({
                  name: artifact.name,
                  'dist-tags': { latest: RUNTIME_VERSION },
                  versions: { [RUNTIME_VERSION]: packageManifest },
                }),
              ),
            },
            {
              id: `tarball:${artifact.name}`,
              path: tarballPath,
              contentType: 'application/octet-stream',
              bytes: sealedAuthorityContent(artifact),
            },
          ];
        }),
      observations,
    );
    owned.push(npm.server);

    const python = await listenLoopback(
      'python',
      (baseUrl) => {
        const wheel = input.authorities.runtime.wheel;
        const sdist = input.authorities.runtime.sdist;
        const wheelPath = `/packages/${wheel.fileName}`;
        const sdistPath = `/packages/${sdist.fileName}`;
        const indexHtml = [
          '<!doctype html><html><body>',
          `<a href="${baseUrl}${wheelPath}#sha256=${wheel.sha256}">${wheel.fileName}</a>`,
          `<a href="${baseUrl}${sdistPath}#sha256=${sdist.sha256}">${sdist.fileName}</a>`,
          '</body></html>',
        ].join('\n');
        return [
          {
            id: 'simple:capture-runtime-client',
            path: '/simple/capture-runtime-client/',
            aliases: [
              '/simple/capture-runtime-client',
              '/simple/capture_runtime_client/',
              '/simple/capture_runtime_client',
            ],
            contentType: 'text/html; charset=utf-8',
            bytes: Buffer.from(indexHtml),
          },
          {
            id: 'python:wheel',
            path: wheelPath,
            contentType: 'application/octet-stream',
            bytes: sealedAuthorityContent(wheel),
          },
          {
            id: 'python:sdist',
            path: sdistPath,
            contentType: 'application/octet-stream',
            bytes: sealedAuthorityContent(sdist),
          },
        ];
      },
      observations,
    );
    owned.push(python.server);

    const cargo = await listenLoopback(
      'cargo',
      (baseUrl) => {
        const crate = input.authorities.runtime.crate;
        return [
          {
            id: 'cargo:config',
            path: '/index/config.json',
            contentType: 'application/json',
            bytes: Buffer.from(JSON.stringify({ dl: `${baseUrl}/api/v1/crates`, api: null })),
          },
          {
            id: 'cargo:index:capture-sidecar-launcher',
            path: '/index/ca/pt/capture-sidecar-launcher',
            contentType: 'application/json',
            bytes: Buffer.from(`${JSON.stringify(cargoIndexRecord(crate))}\n`),
          },
          {
            id: 'cargo:crate',
            path: `/api/v1/crates/capture-sidecar-launcher/${RUNTIME_VERSION}/download`,
            contentType: 'application/octet-stream',
            bytes: sealedAuthorityContent(crate),
          },
        ];
      },
      observations,
    );
    owned.push(cargo.server);

    const allRoutes = [...npm.routes, ...python.routes, ...cargo.routes];
    const preflight = async (): Promise<void> => {
      for (const [baseUrl, routes] of [
        [npm.baseUrl, npm.routes],
        [python.baseUrl, python.routes],
        [cargo.baseUrl, cargo.routes],
      ] as const) {
        for (const route of routes) {
          const response = await fetch(`${baseUrl}${route.path}`);
          if (!response.ok) throw new Error(`Owned registry preflight failed for ${route.id}.`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (sha256(bytes) !== sha256(route.bytes)) {
            throw new Error(`Owned registry preflight bytes drifted for ${route.id}.`);
          }
        }
      }
    };
    return {
      endpoints: {
        npm: npm.baseUrl,
        python: python.baseUrl,
        cargo: `sparse+${cargo.baseUrl}/index/`,
      },
      ports: [npm.port, python.port, cargo.port],
      preflight,
      audit: () => {
        const covered = new Set(
          observations.filter(({ accepted }) => accepted).map(({ routeId }) => routeId),
        );
        const acceptedCount = observations.filter(({ accepted }) => accepted).length;
        return {
          requestCount: observations.length,
          acceptedCount,
          rejectedCount: observations.length - acceptedCount,
          requiredRouteCount: allRoutes.length,
          coveredRouteCount: allRoutes.filter(({ id }) => covered.has(id)).length,
          auditSha256: sha256(canonicalJson(observations)),
        };
      },
      close: async () => {
        const results = await Promise.allSettled(owned.map(closeServer));
        const rejected = results.filter((result) => result.status === 'rejected');
        if (rejected.length > 0) {
          throw new AggregateError(
            rejected.map((result) => (result as PromiseRejectedResult).reason),
            'Failed to close owned registries.',
          );
        }
        return owned.length;
      },
    };
  } catch (error) {
    await Promise.allSettled(owned.map(closeServer));
    throw error;
  }
}

interface CapturedProcessResult {
  readonly status: number;
  readonly stdout: Buffer;
}

function runCapturedProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CapturedProcessResult> {
  return new Promise<CapturedProcessResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.resume();
    child.once('error', rejectPromise);
    child.once('close', (status) => {
      if (status === null) {
        rejectPromise(new Error(`${command} terminated without an exit status.`));
        return;
      }
      resolvePromise({ status, stdout: Buffer.concat(stdout) });
    });
  });
}

async function trackedPaths(root: string): Promise<readonly string[]> {
  const result = await runCapturedProcess('git', ['ls-files', '-z', '--cached'], root);
  if (result.status !== 0) throw new Error('Source root tracked-file inventory is unavailable.');
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter((path) => path.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

async function observeTrackedFile(
  root: string,
  path: string,
): Promise<{ readonly kind: 'file'; readonly bytes: Buffer } | { readonly kind: 'deleted' }> {
  const absolute = resolve(root, path);
  if (!isContained(root, absolute)) throw new Error('Tracked source path escapes its Git root.');
  const details = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!details) return { kind: 'deleted' };
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error('Tracked source content contains a link or non-file entry.');
  }
  const resolvedRoot = await realpath(root);
  const resolvedFile = await realpath(absolute);
  if (!isContained(resolvedRoot, resolvedFile)) {
    throw new Error('Tracked source file resolves outside its Git root.');
  }
  return { kind: 'file', bytes: await readFile(absolute) };
}

async function snapshotGitSource(root: string): Promise<SourceSnapshot> {
  const paths = await trackedPaths(root);
  const hash = createHash('sha256');
  let trackedFileCount = 0;
  for (const path of paths) {
    const observation = await observeTrackedFile(root, path);
    hash.update(path.replaceAll('\\', '/'));
    hash.update('\0');
    if (observation.kind === 'deleted') {
      hash.update('deleted\0');
      continue;
    }
    trackedFileCount += 1;
    hash.update(String(observation.bytes.length));
    hash.update('\0');
    hash.update(sha256(observation.bytes));
    hash.update('\0');
  }
  const headResult = await runCapturedProcess('git', ['rev-parse', '--verify', 'HEAD'], root).catch(
    () => undefined,
  );
  const headText = headResult?.status === 0 ? headResult.stdout.toString('utf8').trim() : '';
  const head = GIT_SHA_PATTERN.test(headText) ? headText : null;
  const statusResult = await runCapturedProcess(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    root,
  ).catch(() => undefined);
  const statusBytes = statusResult?.status === 0 ? statusResult.stdout : undefined;
  return {
    trackedTreeSha256: hash.digest('hex'),
    trackedFileCount,
    head,
    dirty: statusBytes ? statusBytes.length > 0 : null,
    statusSha256: statusBytes ? sha256(statusBytes) : null,
  };
}

async function copyGitTrackedSource(sourceRoot: string, destination: string): Promise<number> {
  await mkdir(destination, { recursive: true });
  const paths = await trackedPaths(sourceRoot);
  let copied = 0;
  for (const path of paths) {
    const observation = await observeTrackedFile(sourceRoot, path);
    if (observation.kind === 'deleted') continue;
    const output = resolve(destination, path);
    if (!isContained(destination, output)) throw new Error('Tracked projection path escapes its root.');
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, observation.bytes, { flag: 'wx' });
    copied += 1;
  }
  return copied;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function snapshotRegularTree(root: string): Promise<TreeSnapshot> {
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new Error('Candidate snapshot root is not a regular directory.');
  }
  const rootRealPath = await realpath(root);
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const details = await lstat(path);
      if (details.isSymbolicLink() || (!details.isFile() && !details.isDirectory())) {
        throw new Error('Candidate snapshot contains a link or non-file entry.');
      }
      const resolvedPath = await realpath(path);
      if (!isContained(rootRealPath, resolvedPath)) {
        throw new Error('Candidate snapshot entry resolves outside its root.');
      }
      if (details.isDirectory()) await visit(path);
      else files.push(path);
    }
  };
  await visit(root);
  files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
  const treeHash = createHash('sha256');
  for (const path of files) {
    const details = await stat(path);
    treeHash.update(relative(root, path).replaceAll('\\', '/'));
    treeHash.update('\0');
    treeHash.update(String(details.size));
    treeHash.update('\0');
    treeHash.update(await hashFile(path));
    treeHash.update('\0');
  }
  return { treeSha256: treeHash.digest('hex'), fileCount: files.length };
}

function replaceUniqueExecutionDeclaration(
  source: string,
  identifier: RegExp,
  declaration: RegExp,
  replacement: string,
  label: string,
): string {
  const identifiers = [...source.matchAll(identifier)];
  const matches = [...source.matchAll(declaration)];
  if (
    identifiers.length !== 1 ||
    matches.length !== 1 ||
    matches[0]?.index === undefined
  ) {
    throw new Error(`${label} declaration is missing or ambiguous.`);
  }
  const match = matches[0];
  return `${source.slice(0, match.index)}${replacement}${source.slice(
    match.index + match[0].length,
  )}`;
}

async function applyProjectionOverlays(input: {
  readonly projectionRoot: string;
  readonly endpoints: RegistryCluster['endpoints'];
  readonly cacheRoot: string;
}): Promise<void> {
  const packagePath = join(input.projectionRoot, 'package.json');
  const packageRecord = parseJson(await readFile(packagePath), 'Projected package.json');
  const dependencies = isRecord(packageRecord.dependencies) ? packageRecord.dependencies : {};
  dependencies['@gx-capture/capture-runtime-client'] = RUNTIME_VERSION;
  dependencies['@gx-capture/capture-workbench-ui'] = RUNTIME_VERSION;
  packageRecord.dependencies = dependencies;
  await writeFile(packagePath, `${JSON.stringify(packageRecord, null, 2)}\n`);

  const workspacePath = join(input.projectionRoot, 'pnpm-workspace.yaml');
  let workspace = await readFile(workspacePath, 'utf8');
  for (const packageName of [
    '@gx-capture/capture-runtime-client',
    '@gx-capture/capture-workbench-ui',
  ]) {
    const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const pattern = new RegExp(`(${escaped}@)[^'"\\s]+`, 'gu');
    if (pattern.test(workspace)) workspace = workspace.replace(pattern, `$1${RUNTIME_VERSION}`);
    else workspace += `\n  - '${packageName}@${RUNTIME_VERSION}'`;
  }
  if (!workspace.endsWith('\n')) workspace += '\n';
  const workspaceOverrides = [
    `  '@gx-capture/capture-runtime-client': '${RUNTIME_VERSION}'`,
    `  '@gx-capture/capture-workbench-ui': '${RUNTIME_VERSION}'`,
  ];
  if (/^overrides:\s*$/mu.test(workspace)) {
    for (const override of workspaceOverrides) {
      const packageName = override.slice(3, override.indexOf("':"));
      const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const pattern = new RegExp(`^[ \\t]*['"]?${escaped}['"]?:[^\\r\\n]*$`, 'mu');
      if (pattern.test(workspace)) workspace = workspace.replace(pattern, override);
      else workspace = workspace.replace(/^overrides:\s*$/mu, (header) => `${header}\n${override}`);
    }
  } else {
    workspace += `overrides:\n${workspaceOverrides.join('\n')}\n`;
  }
  await writeFile(workspacePath, workspace);
  await rm(join(input.projectionRoot, LOCK_PATHS.pnpm), { force: true });
  await writeFile(
    join(input.projectionRoot, '.npmrc'),
    `@gx-capture:registry=${input.endpoints.npm}/\n`,
  );

  const pyprojectPath = join(input.projectionRoot, 'apps/cert-prep-backend/pyproject.toml');
  let pyproject = await readFile(pyprojectPath, 'utf8');
  const pythonDependency = /capture-runtime-client==[^"'\s,\]]+/gu;
  if (!pythonDependency.test(pyproject)) {
    throw new Error('Projected Python manifest omits capture-runtime-client.');
  }
  pyproject = pyproject.replace(pythonDependency, `capture-runtime-client==${RUNTIME_VERSION}`);
  if (/^\[tool\.uv\.sources\]$/mu.test(pyproject)) {
    pyproject = pyproject.replace(
      /^\[tool\.uv\.sources\]$/mu,
      `[tool.uv.sources]\ncapture-runtime-client = { index = "capture-fresh" }`,
    );
  } else {
    pyproject += '\n[tool.uv.sources]\ncapture-runtime-client = { index = "capture-fresh" }\n';
  }
  pyproject += [
    '',
    '[[tool.uv.index]]',
    'name = "capture-fresh"',
    `url = "${input.endpoints.python}/simple/"`,
    'explicit = true',
    '',
  ].join('\n');
  await writeFile(pyprojectPath, pyproject);

  const cargoManifestPath = join(
    input.projectionRoot,
    'apps/cert-prep-desktop/src-tauri/Cargo.toml',
  );
  let cargoManifest = await readFile(cargoManifestPath, 'utf8');
  const cargoDependency = /^capture-sidecar-launcher\s*=.*$/mu;
  if (!cargoDependency.test(cargoManifest)) {
    throw new Error('Projected Cargo manifest omits capture-sidecar-launcher.');
  }
  cargoManifest = cargoManifest.replace(
    cargoDependency,
    `capture-sidecar-launcher = { version = "=${RUNTIME_VERSION}", registry = "capture-fresh" }`,
  );
  await writeFile(cargoManifestPath, cargoManifest);
  const cargoConfigurationPath = join(input.projectionRoot, '.cargo/config.toml');
  await mkdir(dirname(cargoConfigurationPath), { recursive: true });
  await writeFile(
    cargoConfigurationPath,
    `[registries.capture-fresh]\nindex = "${input.endpoints.cargo}"\n`,
  );

  const runtimeVersionPath = join(input.projectionRoot, 'tools/capture-runtime-version.mts');
  const runtimeVersionSource = await readFile(runtimeVersionPath, 'utf8');
  const patchedRuntimeVersionSource = replaceUniqueExecutionDeclaration(
    runtimeVersionSource,
    /^export const CAPTURE_RUNTIME_VERSION\b[^\r\n]*$/gmu,
    /^export const CAPTURE_RUNTIME_VERSION = '\d+\.\d+\.\d+' as const;$/gmu,
    `export const CAPTURE_RUNTIME_VERSION = '${RUNTIME_VERSION}' as const;`,
    'Projected TypeScript CAPTURE_RUNTIME_VERSION',
  );
  const patchedRuntimeWithLauncher = replaceUniqueExecutionDeclaration(
    patchedRuntimeVersionSource,
    /^export const CAPTURE_SIDECAR_LAUNCHER_VERSION\b[^\r\n]*$/gmu,
    /^export const CAPTURE_SIDECAR_LAUNCHER_VERSION = '\d+\.\d+\.\d+' as const;$/gmu,
    `export const CAPTURE_SIDECAR_LAUNCHER_VERSION = '${RUNTIME_VERSION}' as const;`,
    'Projected TypeScript CAPTURE_SIDECAR_LAUNCHER_VERSION',
  );
  await writeFile(runtimeVersionPath, patchedRuntimeWithLauncher);

  const nativeConstantsPath = join(
    input.projectionRoot,
    'apps/cert-prep-desktop/src-tauri/src/constants.rs',
  );
  const nativeConstantsSource = await readFile(nativeConstantsPath, 'utf8');
  const patchedNativeVersion = replaceUniqueExecutionDeclaration(
    nativeConstantsSource,
    /^pub\(crate\) const CAPTURE_RUNTIME_VERSION\b[^\r\n]*$/gmu,
    /^pub\(crate\) const CAPTURE_RUNTIME_VERSION: &str = "\d+\.\d+\.\d+";$/gmu,
    `pub(crate) const CAPTURE_RUNTIME_VERSION: &str = "${RUNTIME_VERSION}";`,
    'Projected Rust CAPTURE_RUNTIME_VERSION',
  );
  const patchedNativeConstants = replaceUniqueExecutionDeclaration(
    patchedNativeVersion,
    /^pub\(crate\) const CAPTURE_RUNTIME_MODEL\b[^\r\n]*$/gmu,
    /^pub\(crate\) const CAPTURE_RUNTIME_MODEL: &str = "capture-runtime@\d+\.\d+\.\d+";$/gmu,
    `pub(crate) const CAPTURE_RUNTIME_MODEL: &str = "capture-runtime@${RUNTIME_VERSION}";`,
    'Projected Rust CAPTURE_RUNTIME_MODEL',
  );
  await writeFile(nativeConstantsPath, patchedNativeConstants);
}

function textBlock(text: string, marker: RegExp, label: string): string {
  const match = marker.exec(text);
  if (!match || match.index < 0) throw new Error(`${label} is missing from its lock.`);
  const rest = text.slice(match.index);
  const next = rest.slice(1).search(/\n(?:\[\[package\]\]| {2}['"]?@?[^\n]+:\s*$)/mu);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

async function readInstalledNpmPackage(
  projectionRoot: string,
  packageName: NpmPackageAuthority['name'],
): Promise<string> {
  const packageRoot = join(projectionRoot, 'node_modules', ...packageName.split('/'));
  const packageManifest = parseJson(
    await readFile(join(packageRoot, 'package.json')),
    `Installed ${packageName} manifest`,
  );
  if (packageManifest.name !== packageName || packageManifest.version !== RUNTIME_VERSION) {
    throw new Error(`Installed ${packageName} identity drifted.`);
  }
  return realpath(packageRoot);
}

async function findNamedDirectory(root: string, name: string): Promise<string> {
  const details = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!details?.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`Installed package search root is unavailable for ${name}.`);
  }
  const visit = async (directory: string): Promise<string | undefined> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.name === name && entry.isDirectory()) return path;
      if (entry.isDirectory()) {
        const found = await visit(path);
        if (found) return found;
      }
    }
    return undefined;
  };
  const found = await visit(root);
  if (!found) throw new Error(`Installed package directory is missing: ${name}.`);
  return found;
}

function tomlPackageBlock(lock: string, packageName: string): string {
  const blocks = lock.split(/(?=^\[\[package\]\]$)/mu);
  const block = blocks.find((candidate) =>
    new RegExp(
      `^name = "${packageName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}"$`,
      'mu',
    ).test(candidate),
  );
  if (!block) throw new Error(`${packageName} is missing from its lock.`);
  return block;
}

async function collectProjectionResolutions(input: {
  readonly projectionRoot: string;
  readonly cacheRoot: string;
  readonly endpoints: RegistryCluster['endpoints'];
  readonly authorities: ProjectionAuthorities;
}): Promise<readonly CapturePackageResolution[]> {
  const pnpmLock = await readFile(join(input.projectionRoot, LOCK_PATHS.pnpm), 'utf8');
  const resolutions: CapturePackageResolution[] = [];
  for (const artifact of expectedNpmPackages(input.authorities)) {
    const marker = new RegExp(
      `^[ \\t]*['"]?${artifact.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}@${RUNTIME_VERSION.replaceAll('.', '\\.')}['"]?:`,
      'mu',
    );
    const block = textBlock(pnpmLock, marker, artifact.name);
    const expectedTarball = `${input.endpoints.npm}/tarballs/${artifact.fileName}`;
    const forbidden = /(?:file|link|path|editable|direct[_-]?url):/iu.test(block);
    const exactRegistry =
      block.includes(expectedTarball) && block.includes(`integrity: ${artifact.integrity}`);
    resolutions.push({
      ecosystem: 'npm',
      packageName: artifact.name,
      version: RUNTIME_VERSION,
      sourceKind: forbidden || !exactRegistry ? 'file' : 'registry',
      sha256: artifact.sha256,
      source: exactRegistry ? expectedTarball : block.slice(0, 120),
      realPath: await readInstalledNpmPackage(input.projectionRoot, artifact.name),
    });
  }

  const uvLock = await readFile(join(input.projectionRoot, LOCK_PATHS.python), 'utf8');
  const pythonBlock = tomlPackageBlock(uvLock, 'capture-runtime-client');
  const expectedPythonRegistry = `${input.endpoints.python}/simple`;
  const expectedWheelUrl = `${input.endpoints.python}/packages/${input.authorities.runtime.wheel.fileName}`;
  const pythonForbidden = /(?:path|editable|direct[_-]?url)\s*=/iu.test(pythonBlock);
  const pythonExact =
    pythonBlock.includes(`version = "${RUNTIME_VERSION}"`) &&
    (pythonBlock.includes(`registry = "${expectedPythonRegistry}"`) ||
      pythonBlock.includes(`registry = "${expectedPythonRegistry}/"`)) &&
    pythonBlock.includes(expectedWheelUrl) &&
    pythonBlock.includes(`sha256:${input.authorities.runtime.wheel.sha256}`);
  const distInfo = await findNamedDirectory(
    join(input.projectionRoot, 'apps/cert-prep-backend/.venv'),
    `capture_runtime_client-${RUNTIME_VERSION}.dist-info`,
  );
  const pythonMetadata = await readFile(join(distInfo, 'METADATA'), 'utf8');
  if (
    !/^Name: capture-runtime-client$/mu.test(pythonMetadata) ||
    !new RegExp(`^Version: ${RUNTIME_VERSION.replaceAll('.', '\\.')}$$`, 'mu').test(pythonMetadata)
  ) {
    throw new Error('Installed Python Capture Runtime client identity drifted.');
  }
  const directUrlPath = join(distInfo, 'direct_url.json');
  const hasDirectUrl = await lstat(directUrlPath).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
  resolutions.push({
    ecosystem: 'python',
    packageName: 'capture-runtime-client',
    version: RUNTIME_VERSION,
    sourceKind: pythonForbidden || !pythonExact ? 'direct-url' : 'registry',
    sha256: input.authorities.runtime.wheel.sha256,
    source: pythonExact ? expectedPythonRegistry : pythonBlock.slice(0, 120),
    realPath: await realpath(distInfo),
    directUrl: hasDirectUrl,
  });

  const cargoLock = await readFile(join(input.projectionRoot, LOCK_PATHS.cargo), 'utf8');
  const cargoBlock = tomlPackageBlock(cargoLock, 'capture-sidecar-launcher');
  const expectedCargoSource = input.endpoints.cargo;
  const cargoForbidden = /(?:path|git|file|link)\s*=/iu.test(cargoBlock);
  const cargoExact =
    cargoBlock.includes(`version = "${RUNTIME_VERSION}"`) &&
    cargoBlock.includes(`source = "${expectedCargoSource}"`) &&
    cargoBlock.includes(`checksum = "${input.authorities.runtime.crate.sha256}"`);
  const crateSource = await findNamedDirectory(
    join(input.cacheRoot, 'cargo/registry/src'),
    `capture-sidecar-launcher-${RUNTIME_VERSION}`,
  );
  const installedCargoManifest = await readFile(join(crateSource, 'Cargo.toml'), 'utf8');
  if (
    !/^name = "capture-sidecar-launcher"$/mu.test(installedCargoManifest) ||
    !new RegExp(`^version = "${RUNTIME_VERSION.replaceAll('.', '\\.')}"$`, 'mu').test(
      installedCargoManifest,
    )
  ) {
    throw new Error('Installed Cargo Capture Runtime package identity drifted.');
  }
  resolutions.push({
    ecosystem: 'cargo',
    packageName: 'capture-sidecar-launcher',
    version: RUNTIME_VERSION,
    sourceKind: cargoForbidden || !cargoExact ? 'path' : 'registry',
    sha256: input.authorities.runtime.crate.sha256,
    source: cargoExact ? expectedCargoSource : cargoBlock.slice(0, 120),
    realPath: await realpath(crateSource),
  });
  return resolutions;
}

const projectionProcessManager = new OwnedProjectionProcessManager();

function runProjectionCommand(command: ProjectionCommand): Promise<void> {
  return projectionProcessManager.run(command);
}

function closeProjectionChildren(): Promise<number> {
  return projectionProcessManager.closeOwnedProcesses();
}

async function assertLoopbackPortsClosed(ports: readonly number[]): Promise<number> {
  let occupied = 0;
  for (const port of ports) {
    const available = await new Promise<boolean>((resolvePromise, rejectPromise) => {
      const probe = createNetServer();
      probe.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') resolvePromise(false);
        else rejectPromise(error);
      });
      probe.listen(port, '127.0.0.1', () => {
        probe.close((error) => (error ? rejectPromise(error) : resolvePromise(true)));
      });
    });
    if (!available) occupied += 1;
  }
  return occupied;
}

async function removeProjectionTempRoot(root: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedSystemTemp = await realpath(tmpdir());
  const actualRoot = await realpath(resolvedRoot);
  if (
    actualRoot === resolvedSystemTemp ||
    !isContained(resolvedSystemTemp, actualRoot) ||
    basename(actualRoot).length < 8
  ) {
    throw new Error('Refusing to remove an unsafe projection temp root.');
  }
  await rm(actualRoot, { recursive: true, force: false });
}

async function validateProjectionTempRoot(
  root: string,
  forbiddenRoots: readonly string[],
): Promise<void> {
  const details = await lstat(root);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error('Projection temp root is not a regular directory.');
  }
  const actualRoot = await realpath(root);
  const actualSystemTemp = await realpath(tmpdir());
  if (actualRoot === actualSystemTemp || !isContained(actualSystemTemp, actualRoot)) {
    throw new Error('Projection root is outside the OS temp directory.');
  }
  for (const forbiddenRoot of forbiddenRoots) {
    const resolvedForbidden = await realpath(forbiddenRoot).catch(() => resolve(forbiddenRoot));
    if (isContained(resolvedForbidden, actualRoot) || isContained(actualRoot, resolvedForbidden)) {
      throw new Error('Projection temp root overlaps a source or candidate root.');
    }
  }
  const gitProbe = await runCapturedProcess(
    'git',
    ['rev-parse', '--show-toplevel'],
    actualRoot,
  ).catch(() => undefined);
  if (gitProbe?.status === 0) {
    throw new Error('Projection temp root must be outside every Git worktree.');
  }
}

async function validateProjectionOutputRoot(
  root: string,
  forbiddenRoots: readonly string[],
): Promise<void> {
  const details = await lstat(root);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error('Fresh artifact output root must be a regular directory.');
  }
  const outputRealPath = await realpath(root);
  for (const forbiddenRoot of forbiddenRoots) {
    const resolvedForbidden = await realpath(forbiddenRoot).catch(() => resolve(forbiddenRoot));
    if (
      isContained(resolvedForbidden, outputRealPath) ||
      isContained(outputRealPath, resolvedForbidden)
    ) {
      throw new Error('Fresh artifact output root overlaps a source, candidate, or temp root.');
    }
  }
  const gitProbe = await runCapturedProcess(
    'git',
    ['rev-parse', '--show-toplevel'],
    outputRealPath,
  ).catch(() => undefined);
  if (gitProbe?.status === 0) {
    throw new Error('Fresh artifact output root must be outside every Git worktree.');
  }
}

const defaultDependencies: CaptureFreshProjectionDependencies = {
  validateRuntimeContent: validateRuntimeCandidateContent,
  loadAuthorities: loadProjectionAuthorities,
  createTempRoot: async () => mkdtemp(join(tmpdir(), 'cert-capture-fresh-')),
  validateTempRoot: validateProjectionTempRoot,
  snapshotSource: snapshotGitSource,
  snapshotCandidate: snapshotRegularTree,
  copyTrackedSource: copyGitTrackedSource,
  applyOverlays: applyProjectionOverlays,
  startRegistries: startProjectionRegistries,
  runCommand: runProjectionCommand,
  collectResolutions: collectProjectionResolutions,
  closeOwnedChildren: closeProjectionChildren,
  assertListenersClosed: assertLoopbackPortsClosed,
  removeTempRoot: removeProjectionTempRoot,
  validateOutputRoot: validateProjectionOutputRoot,
  exportFreshArtifact: createFreshProjectionArtifactExporter(),
};

export async function runCaptureFreshProjection(
  rawInput: Readonly<CaptureFreshProjectionInput>,
  overrides: Partial<CaptureFreshProjectionDependencies> = {},
): Promise<CaptureFreshProjectionManifest> {
  if (rawInput.outputRoot && !isAbsolute(rawInput.outputRoot)) {
    throw new Error('Fresh artifact output root must be an absolute path.');
  }
  const input: CaptureFreshProjectionInput = {
    sourceRoot: resolve(rawInput.sourceRoot),
    runtimeCandidateRoot: resolve(rawInput.runtimeCandidateRoot),
    packageCandidateRoot: resolve(rawInput.packageCandidateRoot),
    ...(rawInput.outputRoot ? { outputRoot: resolve(rawInput.outputRoot) } : {}),
  };
  const dependencies = { ...defaultDependencies, ...overrides };
  const inputRoots = [input.sourceRoot, input.runtimeCandidateRoot, input.packageCandidateRoot];

  let sourceBefore: SourceSnapshot | undefined;
  let runtimeBefore: TreeSnapshot | undefined;
  let packageBefore: TreeSnapshot | undefined;
  let sourceAfter: SourceSnapshot | undefined;
  let runtimeAfter: TreeSnapshot | undefined;
  let packageAfter: TreeSnapshot | undefined;
  let authorities: ProjectionAuthorities | undefined;
  let runtimeContent: ValidatedRuntimeCandidateContent | undefined;
  let registry: RegistryCluster | undefined;
  let tempRoot: string | undefined;
  let auditAfterA: RegistryAudit | undefined;
  let locksA: Record<CommandEcosystem, Buffer> | undefined;
  let sourceCopyFileCount = 0;
  let generatedCommandCount = 0;
  let replayCommandCount = 0;
  let resolutionCount = 0;
  let artifactReceipt: FreshProjectionArtifactReceipt | null = null;
  let artifactReceiptSha256: string | undefined;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  let ownedServerCount = 0;
  let ownedChildCount = 0;
  let remainingListenerCount = -1;
  let tempRemoved = false;

  try {
    [sourceBefore, runtimeBefore, packageBefore, authorities, runtimeContent] =
      await Promise.all([
        dependencies.snapshotSource(input.sourceRoot),
        dependencies.snapshotCandidate(input.runtimeCandidateRoot),
        dependencies.snapshotCandidate(input.packageCandidateRoot),
        dependencies.loadAuthorities(input),
        dependencies.validateRuntimeContent({
          candidate: input.runtimeCandidateRoot,
          candidateId: RUNTIME_CANDIDATE_ID,
          candidateManifestSha256: RUNTIME_CANDIDATE_MANIFEST_SHA256,
        }),
      ]);
    assertAuthorities(authorities, runtimeContent);

    tempRoot = await dependencies.createTempRoot();
    assertSafeTempRoot(tempRoot, inputRoots);
    await dependencies.validateTempRoot(tempRoot, inputRoots);
    const projectionA = join(tempRoot, 'projection-a');
    const projectionB = join(tempRoot, 'projection-b');
    const cacheRoot = join(tempRoot, 'cache');
    await mkdir(cacheRoot, { recursive: true });
    const [copyA, copyB] = await Promise.all([
      dependencies.copyTrackedSource(input.sourceRoot, projectionA),
      dependencies.copyTrackedSource(input.sourceRoot, projectionB),
    ]);
    if (copyA !== sourceBefore.trackedFileCount || copyB !== sourceBefore.trackedFileCount) {
      throw new Error('Tracked source projection file count drifted during snapshot copy.');
    }
    sourceCopyFileCount = copyA + copyB;

    registry = await dependencies.startRegistries({
      authorities,
      runtimeCandidateRoot: input.runtimeCandidateRoot,
      packageCandidateRoot: input.packageCandidateRoot,
    });
    if (registry.ports.length !== 3) throw new Error('Fresh projection must own exactly three registries.');
    await Promise.all([
      dependencies.applyOverlays({ projectionRoot: projectionA, endpoints: registry.endpoints, cacheRoot }),
      dependencies.applyOverlays({ projectionRoot: projectionB, endpoints: registry.endpoints, cacheRoot }),
    ]);
    await registry.preflight();

    const generated = commandGraph('A', projectionA, cacheRoot);
    for (const command of generated) await dependencies.runCommand(command);
    generatedCommandCount = generated.length;
    locksA = await readLocks(projectionA);
    await copyLocks(projectionA, projectionB);
    const locksBeforeReplay = await readLocks(projectionB);
    if (!locksEqual(locksA, locksBeforeReplay)) {
      throw new Error('Projection B did not receive byte-exact Projection A locks.');
    }

    auditAfterA = registry.audit();
    assertRegistryAudit(auditAfterA);
    const replay = commandGraph('B', projectionB, cacheRoot);
    for (const command of replay) await dependencies.runCommand(command);
    replayCommandCount = replay.length;
    const auditAfterB = registry.audit();
    assertRegistryAudit(auditAfterB);
    if (auditAfterB.requestCount !== auditAfterA.requestCount) {
      throw new Error('Projection B made a registry request despite frozen offline replay.');
    }

    const locksAfterReplay = await readLocks(projectionB);
    if (!locksEqual(locksA, locksAfterReplay)) {
      throw new Error('Projection B changed a lock during frozen offline replay.');
    }
    const resolutions = await dependencies.collectResolutions({
      projectionRoot: projectionB,
      cacheRoot,
      endpoints: registry.endpoints,
      authorities,
    });
    assertCaptureResolutions(resolutions, authorities, [
      input.sourceRoot,
      input.runtimeCandidateRoot,
      input.packageCandidateRoot,
    ], [projectionB, cacheRoot]);
    resolutionCount = resolutions.length;

    const lockHashes = {
      pnpm: sha256(locksA.pnpm),
      python: sha256(locksA.python),
      cargo: sha256(locksA.cargo),
    };
    const lockSetSha256 = sha256(canonicalJson(lockHashes));
    if (input.outputRoot) {
      await dependencies.validateOutputRoot(input.outputRoot, [...inputRoots, tempRoot]);
      if (dependencies.exportFreshArtifact) {
        const exportRequest: FreshProjectionArtifactExportRequest = {
          projectionRoot: projectionB,
          outputRoot: input.outputRoot,
          runtimeCandidateRoot: input.runtimeCandidateRoot,
          packageCandidateRoot: input.packageCandidateRoot,
          sourceTrackedTreeSha256: sourceBefore.trackedTreeSha256,
          runtimeCandidateId: authorities.runtime.candidateId,
          packageCandidateId: authorities.packages.candidateId,
          lockSetSha256,
        };
        artifactReceipt = await dependencies.exportFreshArtifact(exportRequest);
        if (artifactReceipt) {
          artifactReceiptSha256 = validateArtifactReceipt(artifactReceipt, exportRequest);
          await verifyExportedArtifact(input.outputRoot, artifactReceipt);
        }
      }
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (registry) {
      try {
        ownedServerCount = await registry.close();
        if (ownedServerCount !== 3) {
          cleanupErrors.push(new Error('Cleanup did not close exactly three owned registries.'));
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      ownedChildCount = await dependencies.closeOwnedChildren();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (registry) {
      try {
        remainingListenerCount = await dependencies.assertListenersClosed(registry.ports);
        if (remainingListenerCount !== 0) {
          cleanupErrors.push(new Error('Owned loopback listeners remain after cleanup.'));
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else {
      remainingListenerCount = 0;
    }
    try {
      [sourceAfter, runtimeAfter, packageAfter] = await Promise.all([
        dependencies.snapshotSource(input.sourceRoot),
        dependencies.snapshotCandidate(input.runtimeCandidateRoot),
        dependencies.snapshotCandidate(input.packageCandidateRoot),
      ]);
      if (sourceBefore && !sameSource(sourceBefore, sourceAfter)) {
        cleanupErrors.push(new Error('Tracked source content changed during fresh projection.'));
      }
      if (runtimeBefore && !sameTree(runtimeBefore, runtimeAfter)) {
        cleanupErrors.push(new Error('J30 runtime candidate changed during fresh projection.'));
      }
      if (packageBefore && !sameTree(packageBefore, packageAfter)) {
        cleanupErrors.push(new Error('J16 package candidate changed during fresh projection.'));
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (tempRoot) {
      try {
        assertSafeTempRoot(tempRoot, inputRoots);
        await dependencies.validateTempRoot(tempRoot, inputRoots);
        await dependencies.removeTempRoot(tempRoot);
        tempRemoved = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }

  if (primaryError || cleanupErrors.length > 0) {
    const errors = [...(primaryError ? [primaryError] : []), ...cleanupErrors];
    throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Fresh projection and cleanup failed.');
  }
  if (!sourceBefore || !sourceAfter || !runtimeBefore || !runtimeAfter || !packageBefore || !packageAfter || !authorities || !runtimeContent || !auditAfterA || !locksA) {
    throw new Error('Fresh projection completed without sealed evidence.');
  }

  const lockHashes = {
    pnpm: sha256(locksA.pnpm),
    python: sha256(locksA.python),
    cargo: sha256(locksA.cargo),
  };
  const lockSetSha256 = sha256(canonicalJson(lockHashes));
  const manifest: CaptureFreshProjectionManifest = {
    schemaVersion: '1',
    scope: 'local-candidate-projection',
    runtime: {
      version: RUNTIME_VERSION,
      candidateId: authorities.runtime.candidateId,
      candidateManifestSha256: authorities.runtime.manifestSha256,
      packageCandidateId: authorities.packages.candidateId,
      packageCandidateManifestSha256: authorities.packages.manifestSha256,
      packageManifestSha256: authorities.packages.packageManifestSha256,
      contractSetSha256: authorities.runtime.contractSetSha256,
      runtimeSha256: runtimeContent.runtime.sha256,
      ocrArchiveSha256: runtimeContent.ocrArchive.sha256,
      ocrExecutableSha256: runtimeContent.ocrExecutable.sha256,
      catalogSha256: runtimeContent.catalog.sha256,
      profileSha256: runtimeContent.profile.sha256,
      wheelSha256: authorities.runtime.wheel.sha256,
      sdistSha256: authorities.runtime.sdist.sha256,
      crateSha256: authorities.runtime.crate.sha256,
      npmPackageSha256: expectedNpmPackages(authorities).map(({ sha256: digest }) => digest),
    },
    checkout: {
      sourceCommit: informationalCommit(authorities.runtime.sourceCommit),
      packageSourceCommit: informationalCommit(authorities.packages.sourceCommit),
      headBefore: informationalCommit(sourceBefore.head),
      headAfter: informationalCommit(sourceAfter.head),
      dirtyBefore: sourceBefore.dirty,
      dirtyAfter: sourceAfter.dirty,
      statusBeforeSha256: informationalDigest(sourceBefore.statusSha256),
      statusAfterSha256: informationalDigest(sourceAfter.statusSha256),
      trackedTreeSha256: sourceBefore.trackedTreeSha256,
      trackedFileCount: sourceBefore.trackedFileCount,
    },
    candidates: {
      runtimeTreeSha256: runtimeBefore.treeSha256,
      runtimeFileCount: runtimeBefore.fileCount,
      packageTreeSha256: packageBefore.treeSha256,
      packageFileCount: packageBefore.fileCount,
    },
    registries: {
      ownedServerCount: 3,
      requestCount: auditAfterA.requestCount,
      acceptedRequestCount: auditAfterA.acceptedCount,
      rejectedRequestCount: 0,
      requiredRouteCount: auditAfterA.requiredRouteCount,
      coveredRouteCount: auditAfterA.coveredRouteCount,
      auditSha256: auditAfterA.auditSha256,
    },
    projections: {
      sourceCopyFileCount,
      generatedCommandCount,
      replayCommandCount,
      replayRegistryRequestCount: 0,
      locksByteEqual: true,
      pnpmLockSha256: lockHashes.pnpm,
      pythonLockSha256: lockHashes.python,
      cargoLockSha256: lockHashes.cargo,
      lockSetSha256,
      captureResolutionCount: resolutionCount as 4,
    },
    artifactExport: {
      freshArtifactExported: artifactReceipt !== null,
      installedAcceptanceProven: false,
      ...(artifactReceipt
        ? {
            artifactKind: artifactReceipt.artifactKind,
            artifactBytes: artifactReceipt.bytes,
            artifactSha256: artifactReceipt.sha256,
            receiptSha256: artifactReceiptSha256,
          }
        : {}),
    },
    cleanup: {
      ownedServerCount,
      ownedChildCount,
      remainingListenerCount,
      tempRemoved,
      sourceUnchanged: sameSource(sourceBefore, sourceAfter),
      runtimeCandidateUnchanged: sameTree(runtimeBefore, runtimeAfter),
      packageCandidateUnchanged: sameTree(packageBefore, packageAfter),
    },
  };
  assertPrivacySafeManifest(manifest, [...inputRoots, ...(input.outputRoot ? [input.outputRoot] : [])]);
  return manifest;
}

function parseCliArguments(args: readonly string[]): CaptureFreshProjectionInput {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || !value || values.has(name)) {
      throw new Error('CLI arguments must be unique --name value pairs.');
    }
    values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`Missing required argument: ${name}.`);
    return value;
  };
  const allowed = new Set([
    '--source-root',
    '--runtime-candidate-root',
    '--package-candidate-root',
    '--output-root',
  ]);
  if ([...values.keys()].some((name) => !allowed.has(name))) {
    throw new Error('Unknown fresh projection CLI argument.');
  }
  return {
    sourceRoot: required('--source-root'),
    runtimeCandidateRoot: required('--runtime-candidate-root'),
    packageCandidateRoot: required('--package-candidate-root'),
    ...(values.get('--output-root') ? { outputRoot: values.get('--output-root') } : {}),
  };
}

async function main(): Promise<void> {
  const manifest = await runCaptureFreshProjection(parseCliArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
