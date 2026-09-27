import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type {
  FreshProjectionArtifactExportRequest,
  FreshProjectionArtifactExporter,
  FreshProjectionArtifactReceipt,
} from './capture-fresh-projection.mts';
import { resolveProjectionInvocation } from './capture-projection-process.mts';

const RUNTIME_VERSION = '0.4.2' as const;
const BACKEND_VERSION = '0.1.0-alpha.1' as const;
const TARGET = 'x86_64-pc-windows-msvc' as const;
const NSIS_EXTRACTOR_PATH = 'C:\\Program Files\\7-Zip\\7z.exe';
const NSIS_EXTRACTOR_VERSION = '25.01' as const;
const NSIS_EXTRACTOR_SHA256 =
  '4cd7d776c686427226a151789d2d61f0b2ed2c392148cc4e69c0238362fafecf';
const PROFILE_PATH = '_internal/capture_runtime/assets/ocr-profile.json';
const RUNTIME_FILE = `capture-runtime-${TARGET}.exe`;
const SCHEMA_FILE = 'capture-document-v2.schema.json';
const BACKEND_FILE = 'cert-prep-backend.exe';
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface FreshArtifactCommand {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface FreshArtifactCommandResult {
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export interface FreshArtifactArchiveExtractor {
  readonly authorityClass: 'local-pinned-hash';
  readonly version: '25.01';
  readonly sha256: string;
  inspectArchive(archivePath: string): Promise<string>;
  extractArchive(
    archivePath: string,
    members: readonly string[],
    outputRoot: string,
  ): Promise<void>;
}

export interface FreshProjectionArtifactExporterOptions {
  readonly extractorPath?: string;
  readonly runCommand?: (
    command: FreshArtifactCommand,
  ) => Promise<FreshArtifactCommandResult>;
  readonly extractor?: FreshArtifactArchiveExtractor;
  readonly readEmbeddedProvenance?: (input: {
    readonly projectionRoot: string;
    readonly backendExecutable: string;
  }) => Promise<Buffer>;
  readonly verifyOutputFiles?: (input: {
    readonly outputRoot: string;
    readonly artifactFileName: string;
    readonly artifactBytes: number;
    readonly artifactSha256: string;
    readonly receiptFileName: string;
    readonly receipt: FreshProjectionArtifactReceipt;
  }) => Promise<void>;
}

interface CandidateArtifactDescriptor {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface CandidateObservation extends CandidateArtifactDescriptor {
  readonly content: Buffer;
}

interface RuntimeAuthority {
  readonly candidateManifestSha256: string;
  readonly candidateId: string;
  readonly contractSetSha256: string;
  readonly runtime: CandidateObservation;
  readonly runtimeManifest: CandidateObservation;
  readonly schema: CandidateObservation;
  readonly catalog: CandidateObservation;
  readonly contract: CandidateObservation;
  readonly ocrArchive: CandidateObservation;
  readonly ocrFilesManifest: CandidateObservation;
  readonly pythonWheel: CandidateObservation;
  readonly profile: CandidateObservation;
  readonly profilePath: string;
}

interface PackageAuthority {
  readonly candidateManifestSha256: string;
  readonly candidateId: string;
  readonly packageManifestSha256: string;
  readonly contractSetSha256: string;
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
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

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function parseJson(bytes: Uint8Array, label: string): JsonRecord {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as JsonRecord;
}

function stringField(value: JsonRecord, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error(`${label} ${key} is invalid.`);
  }
  return field;
}

function recordField(value: JsonRecord, key: string, label: string): JsonRecord {
  const field = value[key];
  if (!field || typeof field !== 'object' || Array.isArray(field)) {
    throw new Error(`${label} ${key} is invalid.`);
  }
  return field as JsonRecord;
}

function arrayField(value: JsonRecord, key: string, label: string): readonly unknown[] {
  const field = value[key];
  if (!Array.isArray(field)) throw new Error(`${label} ${key} is invalid.`);
  return field;
}

function descriptorFrom(value: unknown, label: string): CandidateArtifactDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  const record = value as Record<string, unknown>;
  const path = stringField(record, 'path', label);
  const bytes = record['bytes'];
  const digest = record['sha256'];
  assertPositiveInteger(bytes, `${label} bytes`);
  assertDigest(digest, `${label} sha256`);
  return { path, bytes, sha256: digest };
}

async function readRegularFile(root: string, path: string, label: string): Promise<Buffer> {
  const absolute = resolve(root, path);
  if (!isContained(root, absolute) || basename(path) !== basename(absolute)) {
    throw new Error(`${label} path escapes its root.`);
  }
  const details = await lstat(absolute).catch(() => undefined);
  if (!details?.isFile() || details.isSymbolicLink()) {
    throw new Error(`${label} is missing or not a regular file.`);
  }
  const realRoot = await realpath(root);
  const realFile = await realpath(absolute);
  if (!isContained(realRoot, realFile)) throw new Error(`${label} resolves outside its root.`);
  return readFile(realFile);
}

async function readCandidateManifest(
  root: string,
  expectedKind: 'runtime' | 'npm-package-set',
  expectedId: string,
): Promise<{ readonly bytes: Buffer; readonly manifest: JsonRecord; readonly artifacts: ReadonlyMap<string, CandidateArtifactDescriptor> }> {
  const bytes = await readRegularFile(root, 'candidate-manifest.json', `${expectedKind} candidate manifest`);
  const manifestSha256 = sha256(bytes);
  const manifest = parseJson(bytes, `${expectedKind} candidate manifest`);
  if (
    manifest.schemaVersion !== '1' ||
    manifest.candidateKind !== expectedKind ||
    manifest.releaseVersion !== RUNTIME_VERSION ||
    manifest.candidateId !== expectedId
  ) {
    throw new Error(`${expectedKind} candidate manifest identity drifted.`);
  }
  const baseManifest = { ...manifest };
  delete baseManifest.candidateId;
  if (sha256(JSON.stringify(baseManifest)) !== expectedId) {
    throw new Error(`${expectedKind} candidate ID derivation drifted.`);
  }
  const artifacts = new Map<string, CandidateArtifactDescriptor>();
  for (const entry of arrayField(manifest, 'artifacts', `${expectedKind} candidate manifest`)) {
    const descriptor = descriptorFrom(entry, `${expectedKind} candidate artifact`);
    if (artifacts.has(descriptor.path)) throw new Error(`${expectedKind} candidate artifact inventory is duplicated.`);
    artifacts.set(descriptor.path, descriptor);
  }
  if (manifestSha256.length !== 64) throw new Error(`${expectedKind} candidate manifest hash is invalid.`);
  return { bytes, manifest, artifacts };
}

async function readCandidateArtifact(
  root: string,
  descriptor: CandidateArtifactDescriptor,
  label: string,
): Promise<CandidateObservation> {
  const content = await readRegularFile(root, descriptor.path, label);
  if (content.length !== descriptor.bytes || sha256(content) !== descriptor.sha256) {
    throw new Error(`${label} bytes do not match its candidate manifest.`);
  }
  return { ...descriptor, content };
}

function findArtifact(
  artifacts: ReadonlyMap<string, CandidateArtifactDescriptor>,
  path: string,
  label: string,
): CandidateArtifactDescriptor {
  const descriptor = artifacts.get(path);
  if (!descriptor) throw new Error(`${label} is missing from the candidate manifest.`);
  return descriptor;
}

async function loadRuntimeAuthority(
  request: FreshProjectionArtifactExportRequest,
): Promise<RuntimeAuthority> {
  const candidate = await readCandidateManifest(
    request.runtimeCandidateRoot,
    'runtime',
    request.runtimeCandidateId,
  );
  const runtimeManifest = parseJson(candidate.bytes, 'J30 candidate manifest');
  const runtimeVersion = runtimeManifest.releaseVersion;
  if (runtimeVersion !== RUNTIME_VERSION) throw new Error('J30 runtime candidate version drifted.');
  if (runtimeManifest.packageCandidateId !== request.packageCandidateId) {
    throw new Error('J30 candidate package linkage drifted.');
  }
  const runtimeDescriptor = findArtifact(
    candidate.artifacts,
    `runtime/${RUNTIME_FILE}`,
    'J30 runtime executable',
  );
  const schemaDescriptor = findArtifact(
    candidate.artifacts,
    `runtime/${SCHEMA_FILE}`,
    'J30 runtime schema',
  );
  const runtimeManifestDescriptor = findArtifact(
    candidate.artifacts,
    'runtime/capture-runtime-manifest.json',
    'J30 runtime manifest',
  );
  const catalogDescriptor = findArtifact(
    candidate.artifacts,
    'runtime/capture-engine-catalog.json',
    'J30 engine catalog',
  );
  const contractDescriptor = findArtifact(
    candidate.artifacts,
    'contracts/contract-set.json',
    'J30 contract set',
  );
  const wheelPath = `python/capture_runtime_client-${RUNTIME_VERSION}-py3-none-any.whl`;
  const wheelDescriptor = findArtifact(candidate.artifacts, wheelPath, 'J30 Python wheel');
  const [runtime, schema, runtimeManifestArtifact, catalog, contract, pythonWheel] = await Promise.all([
    readCandidateArtifact(request.runtimeCandidateRoot, runtimeDescriptor, 'J30 runtime executable'),
    readCandidateArtifact(request.runtimeCandidateRoot, schemaDescriptor, 'J30 runtime schema'),
    readCandidateArtifact(request.runtimeCandidateRoot, runtimeManifestDescriptor, 'J30 runtime manifest'),
    readCandidateArtifact(request.runtimeCandidateRoot, catalogDescriptor, 'J30 engine catalog'),
    readCandidateArtifact(request.runtimeCandidateRoot, contractDescriptor, 'J30 contract set'),
    readCandidateArtifact(request.runtimeCandidateRoot, wheelDescriptor, 'J30 Python wheel'),
  ]);
  const captureRuntimeManifest = parseJson(runtimeManifestArtifact.content, 'J30 Capture Runtime manifest');
  if (
    captureRuntimeManifest.runtimeVersion !== RUNTIME_VERSION ||
    captureRuntimeManifest.fileName !== RUNTIME_FILE ||
    captureRuntimeManifest.schemaFileName !== SCHEMA_FILE ||
    captureRuntimeManifest.bytes !== runtime.bytes ||
    captureRuntimeManifest.sha256 !== runtime.sha256 ||
    captureRuntimeManifest.schemaSha256 !== schema.sha256
  ) {
    throw new Error('J30 runtime manifest does not bind the exact runtime bytes.');
  }
  const catalogRecord = parseJson(catalog.content, 'J30 engine catalog');
  if (catalogRecord.runtimeVersion !== RUNTIME_VERSION) throw new Error('J30 engine catalog version drifted.');
  const requirements = arrayField(catalogRecord, 'requirements', 'J30 engine catalog');
  const ocrRequirements = requirements.filter(
    (value) => value && typeof value === 'object' && !Array.isArray(value) && (value as JsonRecord).requirementId === 'windowsml-ocr',
  );
  if (ocrRequirements.length !== 1) throw new Error('J30 engine catalog must contain one WindowsML OCR requirement.');
  const ocrRequirement = ocrRequirements[0] as JsonRecord;
  const workers = arrayField(ocrRequirement, 'artifacts', 'J30 WindowsML OCR requirement');
  if (workers.length !== 1) throw new Error('J30 engine catalog must contain one WindowsML OCR worker.');
  const workerFileName = stringField(workers[0] as JsonRecord, 'fileName', 'J30 OCR worker');
  if (basename(workerFileName) !== workerFileName || !workerFileName.endsWith('.zip')) {
    throw new Error('J30 OCR worker file name is unsafe.');
  }
  const workerDescriptor = findArtifact(candidate.artifacts, `runtime/${workerFileName}`, 'J30 OCR archive');
  const filesManifestFileName = workerFileName.replace(/\.zip$/u, '-files.json');
  const filesManifestDescriptor = findArtifact(
    candidate.artifacts,
    `runtime/${filesManifestFileName}`,
    'J30 OCR files manifest',
  );
  const [ocrArchive, ocrFilesManifest] = await Promise.all([
    readCandidateArtifact(request.runtimeCandidateRoot, workerDescriptor, 'J30 OCR archive'),
    readCandidateArtifact(request.runtimeCandidateRoot, filesManifestDescriptor, 'J30 OCR files manifest'),
  ]);
  const workerSha256 = (workers[0] as JsonRecord).sha256;
  const workerBytes = (workers[0] as JsonRecord).bytes;
  const filesManifestSha256 = (workers[0] as JsonRecord).filesManifestSha256;
  assertDigest(workerSha256, 'J30 OCR archive catalog hash');
  assertPositiveInteger(workerBytes, 'J30 OCR archive catalog bytes');
  assertDigest(filesManifestSha256, 'J30 OCR files manifest catalog hash');
  if (
    workerFileName !== `capture-engine-ocr-${RUNTIME_VERSION}-windows-x64.zip` ||
    workerSha256 !== ocrArchive.sha256 ||
    workerBytes !== ocrArchive.bytes ||
    filesManifestSha256 !== ocrFilesManifest.sha256
  ) {
    throw new Error('J30 OCR archive or files manifest does not match its catalog.');
  }
  const filesManifest = parseJson(ocrFilesManifest.content, 'J30 OCR files manifest');
  const profileEntries = arrayField(filesManifest, 'files', 'J30 OCR files manifest').filter(
    (value) => value && typeof value === 'object' && !Array.isArray(value) && (value as JsonRecord).path === PROFILE_PATH,
  );
  if (profileEntries.length !== 1) throw new Error('J30 OCR files manifest omits the profile authority.');
  const profileDescriptor = descriptorFrom(profileEntries[0], 'J30 OCR profile authority');
  const contractSetSha256 = sha256(contract.content);
  const declaredContractSetSha256 = stringField(candidate.manifest, 'contractSetSha256', 'J30 candidate manifest');
  if (declaredContractSetSha256 !== contractSetSha256) {
    throw new Error('J30 candidate contract provenance drifted.');
  }
  if (captureRuntimeManifest.contractSetSha256 && captureRuntimeManifest.contractSetSha256 !== contractSetSha256) {
    throw new Error('J30 runtime manifest contract provenance drifted.');
  }
  return {
    candidateManifestSha256: sha256(candidate.bytes),
    candidateId: request.runtimeCandidateId,
    contractSetSha256,
    runtime,
    runtimeManifest: runtimeManifestArtifact,
    schema,
    catalog,
    contract,
    ocrArchive,
    ocrFilesManifest,
    pythonWheel,
    profile: { ...profileDescriptor, content: Buffer.alloc(0) },
    profilePath: PROFILE_PATH,
  };
}

async function loadPackageAuthority(
  request: FreshProjectionArtifactExportRequest,
): Promise<PackageAuthority> {
  const candidate = await readCandidateManifest(
    request.packageCandidateRoot,
    'npm-package-set',
    request.packageCandidateId,
  );
  const packageManifestDescriptor = findArtifact(
    candidate.artifacts,
    'package-manifest.json',
    'J16 package manifest',
  );
  const packageManifest = await readCandidateArtifact(
    request.packageCandidateRoot,
    packageManifestDescriptor,
    'J16 package manifest',
  );
  const packageManifestSha256 = sha256(packageManifest.content);
  if (candidate.manifest.packageManifestSha256 !== packageManifestSha256) {
    throw new Error('J16 package manifest provenance drifted.');
  }
  const contractDescriptor = findArtifact(
    candidate.artifacts,
    'contracts/contract-set.json',
    'J16 contract set',
  );
  const contract = await readCandidateArtifact(
    request.packageCandidateRoot,
    contractDescriptor,
    'J16 contract set',
  );
  const contractSetSha256 = sha256(contract.content);
  const declaredContractSetSha256 = stringField(candidate.manifest, 'contractSetSha256', 'J16 candidate manifest');
  if (declaredContractSetSha256 !== contractSetSha256) throw new Error('J16 contract provenance drifted.');
  return {
    candidateManifestSha256: sha256(candidate.bytes),
    candidateId: request.packageCandidateId,
    packageManifestSha256,
    contractSetSha256,
  };
}

async function writeStagedFile(
  stageRoot: string,
  relativePath: string,
  content: Uint8Array,
  expected: CandidateArtifactDescriptor,
): Promise<CandidateObservation> {
  const destination = resolve(stageRoot, relativePath);
  if (!isContained(stageRoot, destination)) throw new Error('Fresh artifact stage path escapes its root.');
  if (content.length !== expected.bytes || sha256(content) !== expected.sha256) {
    throw new Error(`Fresh artifact stage bytes drifted for ${relativePath}.`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, { flag: 'wx' });
  const staged = await readFile(destination);
  if (staged.length !== expected.bytes || sha256(staged) !== expected.sha256) {
    throw new Error(`Fresh artifact stage verification drifted for ${relativePath}.`);
  }
  return { ...expected, path: relativePath, content: staged };
}

async function requireEmptyDirectory(root: string, label: string): Promise<void> {
  const details = await lstat(root).catch(() => undefined);
  if (!details) {
    await mkdir(root, { recursive: true });
    return;
  }
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${label} must be a regular directory.`);
  if ((await readdir(root)).length > 0) throw new Error(`${label} must be empty.`);
}

async function assertOutputRoot(request: FreshProjectionArtifactExportRequest): Promise<string> {
  const outputRoot = resolve(request.outputRoot);
  if (!isAbsolute(request.outputRoot)) throw new Error('Fresh artifact output root must be absolute.');
  for (const [root, label] of [
    [request.projectionRoot, 'projection'],
    [request.runtimeCandidateRoot, 'J30 candidate'],
    [request.packageCandidateRoot, 'J16 candidate'],
  ] as const) {
    if (isContained(root, outputRoot) || isContained(outputRoot, root)) {
      throw new Error(`Fresh artifact output root overlaps the ${label} root.`);
    }
  }
  await requireEmptyDirectory(outputRoot, 'Fresh artifact output root');
  const realRoot = await realpath(outputRoot);
  if (realRoot.toLocaleLowerCase() !== outputRoot.toLocaleLowerCase()) {
    throw new Error('Fresh artifact output root must not be a link or junction.');
  }
  return outputRoot;
}

async function runProcess(command: FreshArtifactCommand): Promise<FreshArtifactCommandResult> {
  const invocation = resolveProjectionInvocation(command.command, command.args);
  return new Promise<FreshArtifactCommandResult>((resolvePromise, rejectPromise) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      shell: invocation.shell,
      windowsHide: invocation.windowsHide,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', rejectPromise);
    child.once('close', (status) => {
      if (status === null) {
        rejectPromise(new Error(`${command.label} terminated without an exit status.`));
      } else {
        resolvePromise({ status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      }
    });
  });
}

function commandEnvironment(overrides: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
  return {
    CI: '1',
    UV_FROZEN: '1',
    UV_OFFLINE: '1',
    UV_LINK_MODE: 'copy',
    CARGO_NET_OFFLINE: 'true',
    ...overrides,
  };
}

async function runChecked(
  runCommand: (command: FreshArtifactCommand) => Promise<FreshArtifactCommandResult>,
  command: FreshArtifactCommand,
): Promise<FreshArtifactCommandResult> {
  const result = await runCommand(command);
  if (result.status !== 0) throw new Error(`${command.label} failed with exit status ${String(result.status)}.`);
  return result;
}

async function createPinnedExtractor(
  extractorPath: string,
  projectionRoot: string,
  runCommand: (command: FreshArtifactCommand) => Promise<FreshArtifactCommandResult>,
): Promise<FreshArtifactArchiveExtractor> {
  const requested = resolve(extractorPath);
  const details = await lstat(requested).catch(() => undefined);
  if (!details?.isFile() || details.isSymbolicLink()) {
    throw new Error('Pinned NSIS extractor is unavailable or not a regular file.');
  }
  const actual = await realpath(requested);
  if (actual.toLocaleLowerCase() !== resolve(NSIS_EXTRACTOR_PATH).toLocaleLowerCase()) {
    throw new Error('Pinned NSIS extractor resolved to an unexpected path.');
  }
  const bytes = await readFile(actual);
  if (sha256(bytes) !== NSIS_EXTRACTOR_SHA256) throw new Error('Pinned NSIS extractor hash drifted.');
  const identity = await runChecked(runCommand, {
    label: 'NSIS extractor identity',
    command: actual,
    args: ['i'],
    cwd: projectionRoot,
    env: {},
  });
  if (!identity.stdout.toString('utf8').includes(`7-Zip ${NSIS_EXTRACTOR_VERSION}`)) {
    throw new Error('Pinned NSIS extractor version drifted.');
  }
  return {
    authorityClass: 'local-pinned-hash',
    version: NSIS_EXTRACTOR_VERSION,
    sha256: NSIS_EXTRACTOR_SHA256,
    inspectArchive: async (archivePath) => {
      await runChecked(runCommand, {
        label: 'Static archive test',
        command: actual,
        args: ['t', '-bd', archivePath],
        cwd: projectionRoot,
        env: {},
      });
      const listing = await runChecked(runCommand, {
        label: 'Static archive listing',
        command: actual,
        args: ['l', '-slt', archivePath],
        cwd: projectionRoot,
        env: {},
      });
      const match = /^Type = (.+)$/mu.exec(listing.stdout.toString('utf8'));
      if (!match?.[1]) throw new Error('Static archive listing omitted its archive type.');
      return match[1].trim();
    },
    extractArchive: async (archivePath, members, outputRoot) => {
      await requireEmptyDirectory(outputRoot, 'Static extraction root');
      await runChecked(runCommand, {
        label: 'Static archive extraction',
        command: actual,
        args: ['x', '-y', '-bd', archivePath, ...members, `-o${outputRoot}`],
        cwd: projectionRoot,
        env: {},
      });
      for (const member of members) {
        const extracted = resolve(outputRoot, member);
        if (!isContained(outputRoot, extracted)) throw new Error('Static extraction member escaped its root.');
        const extractedDetails = await lstat(extracted).catch(() => undefined);
        if (!extractedDetails?.isFile() || extractedDetails.isSymbolicLink()) {
          throw new Error(`Static extraction omitted ${basename(member)}.`);
        }
      }
    },
  };
}

async function readEmbeddedProvenance(
  input: { readonly projectionRoot: string; readonly backendExecutable: string },
  runCommand: (command: FreshArtifactCommand) => Promise<FreshArtifactCommandResult>,
): Promise<Buffer> {
  const script = [
    'from PyInstaller.archive.readers import CArchiveReader',
    'import sys',
    'reader = CArchiveReader(sys.argv[1])',
    'entry = next(name for name in reader.toc if name.replace(chr(92), "/") == "cert_prep_backend/capture-runtime-provenance.json")',
    'sys.stdout.buffer.write(reader.extract(entry))',
  ].join('; ');
  const result = await runChecked(runCommand, {
    label: 'Embedded backend provenance extraction',
    command: 'uv',
    args: [
      'run',
      '--quiet',
      '--frozen',
      '--offline',
      '--cache-dir',
      join(dirname(input.projectionRoot), 'cache', 'uv'),
      '--project',
      join(input.projectionRoot, 'apps/cert-prep-backend'),
      'python',
      '-c',
      script,
      input.backendExecutable,
    ],
    cwd: input.projectionRoot,
    env: commandEnvironment(),
  });
  if (result.stdout.length === 0) throw new Error('Embedded backend provenance was empty.');
  return result.stdout;
}

async function readJsonFile(root: string, relativePath: string, label: string): Promise<{ readonly bytes: Buffer; readonly value: JsonRecord }> {
  const bytes = await readRegularFile(root, relativePath, label);
  return { bytes, value: parseJson(bytes, label) };
}

function observationReceipt(observation: CandidateObservation): { readonly fileName: string; readonly bytes: number; readonly sha256: string } {
  return { fileName: basename(observation.path), bytes: observation.bytes, sha256: observation.sha256 };
}

function assertReceiptPrivacy(receipt: FreshProjectionArtifactReceipt, request: FreshProjectionArtifactExportRequest): void {
  const serialized = JSON.stringify(receipt);
  for (const root of [request.projectionRoot, request.outputRoot, request.runtimeCandidateRoot, request.packageCandidateRoot]) {
    if (root && serialized.toLocaleLowerCase().includes(resolve(root).toLocaleLowerCase())) {
      throw new Error('Fresh artifact receipt contains an absolute local path.');
    }
  }
  if (/https?:\/\/|bearer|authorization|token|raw[_-]?ocr|published|registry/iu.test(serialized)) {
    throw new Error('Fresh artifact receipt contains prohibited private or overclaiming data.');
  }
}

async function verifyOutputFiles(
  outputRoot: string,
  artifactFileName: string,
  artifactBytes: number,
  artifactSha256: string,
  receiptFileName: string,
  receipt: FreshProjectionArtifactReceipt,
): Promise<void> {
  const names = (await readdir(outputRoot)).sort();
  if (names.length !== 2 || !names.includes(artifactFileName) || !names.includes(receiptFileName)) {
    throw new Error('Fresh artifact output must contain exactly one installer and one receipt.');
  }
  for (const name of names) {
    const path = join(outputRoot, name);
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error('Fresh artifact output contains a link or non-file entry.');
  }
  const artifact = await readFile(join(outputRoot, artifactFileName));
  if (artifact.length !== artifactBytes || sha256(artifact) !== artifactSha256) {
    throw new Error('Fresh artifact output installer hash drifted.');
  }
  const receiptContent = await readFile(join(outputRoot, receiptFileName));
  const expectedReceiptContent = Buffer.from(`${canonicalJson(receipt)}\n`);
  if (!receiptContent.equals(expectedReceiptContent)) {
    throw new Error('Fresh artifact receipt content drifted from its canonical bytes.');
  }
  const expectedReceiptName = `cert-prep-installer-receipt-${sha256(canonicalJson(receipt))}.json`;
  if (receiptFileName !== expectedReceiptName) {
    throw new Error('Fresh artifact receipt content address drifted.');
  }
}

async function removeOwnedOutputFile(path: string, bytes: number, digest: string): Promise<void> {
  const details = await lstat(path).catch(() => undefined);
  if (!details?.isFile() || details.isSymbolicLink()) return;
  const content = await readFile(path);
  if (content.length === bytes && sha256(content) === digest) await rm(path, { force: true });
}

async function exportFreshArtifact(
  request: FreshProjectionArtifactExportRequest,
  options: FreshProjectionArtifactExporterOptions,
): Promise<FreshProjectionArtifactReceipt> {
  const outputRoot = await assertOutputRoot(request);
  const projectionRoot = resolve(request.projectionRoot);
  const runCommand = options.runCommand ?? runProcess;
  const extractor = options.extractor ?? (await createPinnedExtractor(options.extractorPath ?? NSIS_EXTRACTOR_PATH, projectionRoot, runCommand));
  if (
    extractor.authorityClass !== 'local-pinned-hash' ||
    extractor.version !== NSIS_EXTRACTOR_VERSION ||
    extractor.sha256.toLocaleLowerCase() !== NSIS_EXTRACTOR_SHA256
  ) {
    throw new Error('NSIS extractor authority drifted.');
  }
  assertDigest(request.sourceTrackedTreeSha256, 'Source tracked tree hash');
  assertDigest(request.lockSetSha256, 'Projection lock set hash');
  const stageRoot = join(projectionRoot, '.fresh-artifact-stage');
  if (!isContained(projectionRoot, stageRoot)) throw new Error('Fresh artifact stage escaped projection B.');
  const installerOutputPath = { path: '', bytes: 0, sha256: '' };
  const receiptOutputPath = { path: '', bytes: 0, sha256: '' };
  try {
    await rm(stageRoot, { recursive: true, force: true });
    await mkdir(stageRoot, { recursive: true });
    const runtimeAuthority = await loadRuntimeAuthority(request);
    const packageAuthority = await loadPackageAuthority(request);
    if (runtimeAuthority.contractSetSha256 !== packageAuthority.contractSetSha256) {
      throw new Error('J30/J16 contract provenance drifted.');
    }
    const stageRuntimeRoot = join(stageRoot, 'capture-runtime');
    const stageProfileRoot = join(stageRoot, 'profile-authority');
    await mkdir(stageRuntimeRoot, { recursive: true });
    await writeStagedFile(stageRuntimeRoot, RUNTIME_FILE, runtimeAuthority.runtime.content, runtimeAuthority.runtime);
    await writeStagedFile(stageRuntimeRoot, SCHEMA_FILE, runtimeAuthority.schema.content, runtimeAuthority.schema);
    await writeStagedFile(stageRuntimeRoot, 'capture-runtime-manifest.json', runtimeAuthority.runtimeManifest.content, runtimeAuthority.runtimeManifest);
    await writeStagedFile(stageRuntimeRoot, 'capture-engine-catalog.json', runtimeAuthority.catalog.content, runtimeAuthority.catalog);
    await writeStagedFile(stageRuntimeRoot, basename(runtimeAuthority.ocrArchive.path), runtimeAuthority.ocrArchive.content, runtimeAuthority.ocrArchive);
    await writeStagedFile(stageRuntimeRoot, basename(runtimeAuthority.ocrFilesManifest.path), runtimeAuthority.ocrFilesManifest.content, runtimeAuthority.ocrFilesManifest);
    await writeStagedFile(join(stageRoot, 'contracts'), 'contract-set.json', runtimeAuthority.contract.content, runtimeAuthority.contract);
    await mkdir(join(stageRoot, 'python'), { recursive: true });
    await writeStagedFile(join(stageRoot, 'python'), basename(runtimeAuthority.pythonWheel.path), runtimeAuthority.pythonWheel.content, runtimeAuthority.pythonWheel);

    const profileExtractRoot = join(stageRoot, 'profile-extract');
    const profileType = (await extractor.inspectArchive(join(request.runtimeCandidateRoot, runtimeAuthority.ocrArchive.path))).toLowerCase();
    if (profileType !== 'zip') throw new Error('J30 OCR archive type drifted.');
    await extractor.extractArchive(
      join(request.runtimeCandidateRoot, runtimeAuthority.ocrArchive.path),
      [PROFILE_PATH],
      profileExtractRoot,
    );
    const profileContent = await readRegularFile(profileExtractRoot, PROFILE_PATH, 'J30 OCR profile authority');
    if (profileContent.length !== runtimeAuthority.profile.bytes || sha256(profileContent) !== runtimeAuthority.profile.sha256) {
      throw new Error('J30 OCR profile authority bytes drifted.');
    }
    const profileObservation: CandidateObservation = { ...runtimeAuthority.profile, content: profileContent };
    await writeStagedFile(stageProfileRoot, 'ocr-profile.json', profileContent, {
      path: PROFILE_PATH,
      bytes: profileObservation.bytes,
      sha256: profileObservation.sha256,
    });

    const backendRoot = join(projectionRoot, 'apps/cert-prep-backend');
    await runChecked(runCommand, {
      label: 'Fresh backend runtime build',
      command: 'uv',
      args: [
        'run',
        '--quiet',
        '--isolated',
        '--cache-dir',
        join(dirname(projectionRoot), 'cache', 'uv'),
        '--python',
        '3.12',
        '--frozen',
        '--offline',
        '--link-mode',
        'copy',
        'python',
        'scripts/build_backend_runtime.py',
        '--target',
        TARGET,
        '--version',
        BACKEND_VERSION,
        '--capture-runtime-root',
        stageRuntimeRoot,
        '--capture-runtime-python-wheel',
        join(stageRoot, 'python', basename(runtimeAuthority.pythonWheel.path)),
      ],
      cwd: backendRoot,
      env: commandEnvironment(),
    });
    const provenanceBytes = await readRegularFile(backendRoot, 'dist/capture-runtime-provenance.json', 'Fresh backend capture provenance');
    const backendRuntimeRoot = join(backendRoot, 'dist/backend-runtime');
    const backendManifestFile = await readJsonFile(backendRuntimeRoot, 'backend-runtime-manifest.json', 'Fresh backend runtime manifest');
    if (
      backendManifestFile.value.kind !== 'python_backend' ||
      backendManifestFile.value.version !== BACKEND_VERSION ||
      backendManifestFile.value.target !== TARGET
    ) {
      throw new Error('Fresh backend runtime manifest identity drifted.');
    }
    const backendArtifact = recordField(backendManifestFile.value, 'artifact', 'Fresh backend runtime manifest');
    const backendArtifactName = stringField(backendArtifact, 'file_name', 'Fresh backend artifact');
    if (basename(backendArtifactName) !== backendArtifactName || !backendArtifactName.endsWith('.zip')) {
      throw new Error('Fresh backend artifact file name is unsafe.');
    }
    const backendArtifactBytes = backendArtifact['bytes'];
    const backendArtifactSha256 = backendArtifact['sha256'];
    assertPositiveInteger(backendArtifactBytes, 'Fresh backend artifact bytes');
    assertDigest(backendArtifactSha256, 'Fresh backend artifact hash');
    const backendArtifactContent = await readRegularFile(backendRuntimeRoot, backendArtifactName, 'Fresh backend artifact');
    if (backendArtifactContent.length !== backendArtifactBytes || sha256(backendArtifactContent) !== backendArtifactSha256) {
      throw new Error('Fresh backend artifact bytes drifted from its manifest.');
    }
    await runChecked(runCommand, {
      label: 'Fresh runtime resource preparation',
      command: 'node',
      args: [
        'apps/cert-prep-desktop/scripts/prepare-runtime-resources.mts',
        '--mode',
        'release',
        '--capture-runtime-root',
        stageRuntimeRoot,
      ],
      cwd: projectionRoot,
      env: commandEnvironment(),
    });
    await requireEmptyDirectory(join(projectionRoot, 'apps/cert-prep-desktop/src-tauri/target', TARGET, 'release', 'bundle', 'nsis'), 'Fresh NSIS bundle root');
    await runChecked(runCommand, {
      label: 'Fresh Cert Prep NSIS build',
      command: 'corepack',
      args: [
        'pnpm',
        'exec',
        'tauri',
        'build',
        '--target',
        TARGET,
        '--bundles',
        'nsis',
        '--ci',
        '--config',
        'apps/cert-prep-desktop/src-tauri/tauri.conf.json',
        '--',
        '--locked',
        '--offline',
      ],
      cwd: projectionRoot,
      env: commandEnvironment({
        CARGO_HOME: join(dirname(projectionRoot), 'cache', 'cargo'),
      }),
    });
    const nsisRoot = join(projectionRoot, 'apps/cert-prep-desktop/src-tauri/target', TARGET, 'release', 'bundle', 'nsis');
    const installerEntries = (await readdir(nsisRoot, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.toLocaleLowerCase().endsWith('.exe'),
    );
    if (installerEntries.length !== 1) throw new Error('Fresh NSIS build must produce exactly one installer.');
    const installerName = installerEntries[0].name;
    if (!/^Cert Prep_.+_x64-setup\.exe$/u.test(installerName)) throw new Error('Fresh NSIS installer name drifted.');
    const installerPath = join(nsisRoot, installerName);
    const installerContent = await readRegularFile(nsisRoot, installerName, 'Fresh NSIS installer');
    installerOutputPath.path = join(outputRoot, installerName);
    installerOutputPath.bytes = installerContent.length;
    installerOutputPath.sha256 = sha256(installerContent);
    const installerType = (await extractor.inspectArchive(installerPath)).toLowerCase();
    if (installerType !== 'nsis') throw new Error('Fresh installer is not an NSIS archive.');
    const extractRoot = join(stageRoot, 'installer-extract');
    const nsisMembers = [
      `resources/${RUNTIME_FILE}`,
      'resources/capture-runtime-manifest.json',
      `resources/${SCHEMA_FILE}`,
      'resources/backend-runtime-manifest.json',
      `resources/${backendArtifactName}`,
    ];
    await extractor.extractArchive(installerPath, nsisMembers, extractRoot);
    const extractedRuntimeRoot = join(extractRoot, 'resources');
    const extractedCaptureRuntime = await readRegularFile(extractedRuntimeRoot, RUNTIME_FILE, 'Extracted Capture Runtime executable');
    const extractedSchema = await readRegularFile(extractedRuntimeRoot, SCHEMA_FILE, 'Extracted Capture Runtime schema');
    const extractedCaptureManifest = await readJsonFile(extractedRuntimeRoot, 'capture-runtime-manifest.json', 'Extracted Capture Runtime manifest');
    if (
      extractedCaptureRuntime.length !== runtimeAuthority.runtime.bytes ||
      sha256(extractedCaptureRuntime) !== runtimeAuthority.runtime.sha256 ||
      extractedSchema.length !== runtimeAuthority.schema.bytes ||
      sha256(extractedSchema) !== runtimeAuthority.schema.sha256 ||
      !extractedCaptureManifest.bytes.equals(runtimeAuthority.runtimeManifest.content)
    ) {
      throw new Error('Extracted Capture Runtime resources drifted from J30 authority.');
    }
    const extractedBackendManifest = await readJsonFile(extractedRuntimeRoot, 'backend-runtime-manifest.json', 'Extracted backend runtime manifest');
    if (canonicalJson(extractedBackendManifest.value) !== canonicalJson(backendManifestFile.value)) {
      throw new Error('Extracted backend runtime manifest drifted from the fresh build.');
    }
    const extractedBackendZip = await readRegularFile(extractedRuntimeRoot, backendArtifactName, 'Extracted backend runtime artifact');
    if (extractedBackendZip.length !== backendArtifactContent.length || sha256(extractedBackendZip) !== backendArtifactSha256) {
      throw new Error('Extracted backend runtime artifact drifted from the fresh build.');
    }
    const backendExtractRoot = join(stageRoot, 'backend-extract');
    const backendArchiveType = (await extractor.inspectArchive(join(extractedRuntimeRoot, backendArtifactName))).toLowerCase();
    if (backendArchiveType !== 'zip') throw new Error('Extracted backend runtime archive type drifted.');
    await extractor.extractArchive(join(extractedRuntimeRoot, backendArtifactName), [BACKEND_FILE], backendExtractRoot);
    const backendExecutable = join(backendExtractRoot, BACKEND_FILE);
    const backendExecutableContent = await readRegularFile(backendExtractRoot, BACKEND_FILE, 'Extracted backend executable');
    if (backendExecutableContent.length < 1) {
      throw new Error('Extracted backend executable bytes are invalid.');
    }
    const embedded = options.readEmbeddedProvenance
      ? await options.readEmbeddedProvenance({ projectionRoot, backendExecutable })
      : await readEmbeddedProvenance({ projectionRoot, backendExecutable }, runCommand);
    if (!Buffer.from(embedded).equals(provenanceBytes)) {
      throw new Error('Embedded backend Capture Runtime provenance drifted from the fresh build.');
    }
    const receipt: FreshProjectionArtifactReceipt = {
      receiptSchemaVersion: '1',
      evidenceKind: 'fresh-build-output',
      artifactKind: 'cert-installer',
      fileName: installerName,
      bytes: installerContent.length,
      sha256: installerOutputPath.sha256,
      freshBuild: true,
      installedAcceptanceProven: false,
      sourceTrackedTreeSha256: request.sourceTrackedTreeSha256,
      runtimeCandidateId: request.runtimeCandidateId,
      packageCandidateId: request.packageCandidateId,
      lockSetSha256: request.lockSetSha256,
      runtime: {
        candidateManifestSha256: runtimeAuthority.candidateManifestSha256,
        contractSetSha256: runtimeAuthority.contractSetSha256,
        runtime: observationReceipt(runtimeAuthority.runtime),
        schema: observationReceipt(runtimeAuthority.schema),
        catalog: observationReceipt(runtimeAuthority.catalog),
        ocrArchive: observationReceipt(runtimeAuthority.ocrArchive),
        ocrFilesManifest: observationReceipt(runtimeAuthority.ocrFilesManifest),
        profile: {
          path: runtimeAuthority.profilePath,
          bytes: profileObservation.bytes,
          sha256: profileObservation.sha256,
        },
        pythonWheel: observationReceipt(runtimeAuthority.pythonWheel),
      },
      packageCandidate: {
        candidateManifestSha256: packageAuthority.candidateManifestSha256,
        packageManifestSha256: packageAuthority.packageManifestSha256,
        contractSetSha256: packageAuthority.contractSetSha256,
      },
      backend: {
        artifact: { fileName: backendArtifactName, bytes: backendArtifactBytes, sha256: backendArtifactSha256 },
        embeddedCaptureRuntimeProvenanceSha256: sha256(embedded),
      },
      installer: { fileName: installerName, bytes: installerContent.length, sha256: installerOutputPath.sha256 },
      extracted: {
        captureRuntime: { fileName: RUNTIME_FILE, bytes: extractedCaptureRuntime.length, sha256: sha256(extractedCaptureRuntime) },
        captureRuntimeManifestSha256: sha256(extractedCaptureManifest.bytes),
        captureDocumentSchemaSha256: sha256(extractedSchema),
        backendRuntimeManifestSha256: sha256(extractedBackendManifest.bytes),
        backendRuntimeArtifact: { fileName: backendArtifactName, bytes: extractedBackendZip.length, sha256: sha256(extractedBackendZip) },
        embeddedCaptureRuntimeProvenanceSha256: sha256(embedded),
      },
      extractor: {
        authorityClass: extractor.authorityClass,
        version: extractor.version,
        sha256: extractor.sha256,
        archiveType: 'Nsis',
      },
    };
    assertReceiptPrivacy(receipt, request);
    const receiptSha256 = sha256(canonicalJson(receipt));
    const receiptFileName = `cert-prep-installer-receipt-${receiptSha256}.json`;
    const receiptContent = Buffer.from(`${canonicalJson(receipt)}\n`);
    const receiptPath = join(outputRoot, receiptFileName);
    await copyFile(installerPath, installerOutputPath.path);
    await writeFile(receiptPath, receiptContent, { flag: 'wx' });
    receiptOutputPath.path = receiptPath;
    receiptOutputPath.bytes = receiptContent.length;
    receiptOutputPath.sha256 = sha256(receiptContent);
    await (options.verifyOutputFiles ?? ((input) => verifyOutputFiles(
      input.outputRoot,
      input.artifactFileName,
      input.artifactBytes,
      input.artifactSha256,
      input.receiptFileName,
      input.receipt,
    )))({
      outputRoot,
      artifactFileName: installerName,
      artifactBytes: installerContent.length,
      artifactSha256: installerOutputPath.sha256,
      receiptFileName,
      receipt,
    });
    return receipt;
  } catch (error) {
    if (receiptOutputPath.path && receiptOutputPath.bytes > 0 && receiptOutputPath.sha256) {
      await removeOwnedOutputFile(receiptOutputPath.path, receiptOutputPath.bytes, receiptOutputPath.sha256);
    }
    if (installerOutputPath.path && installerOutputPath.bytes > 0 && installerOutputPath.sha256) {
      await removeOwnedOutputFile(installerOutputPath.path, installerOutputPath.bytes, installerOutputPath.sha256);
    }
    throw error;
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

export function createFreshProjectionArtifactExporter(
  options: FreshProjectionArtifactExporterOptions = {},
): FreshProjectionArtifactExporter {
  return (request) => exportFreshArtifact(request, options);
}
