import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import {
  assertDownloadedWorkerPathBudget,
  createAcceptanceAppDataDirectory,
  removeAcceptanceAppDataDirectory,
} from './acceptance-app-data.mts';
import { parsePackagedFlowSmokeArgs } from './packaged-flow-smoke/args.mts';
import {
  createAcceptanceRun,
  type AcceptanceRun,
} from './acceptance-artifacts.mts';
import type { SmokeOptions } from './packaged-flow-smoke/types.mts';
import type { PackagedImageUploadSmokeOptions } from './packaged-image-upload-smoke/args.mts';

export interface AcceptanceFixture {
  readonly name: string;
  readonly sha256: string;
  readonly expectedTextIncludes?: readonly string[];
}

export interface AcceptanceRuntimeProvenance {
  readonly distributionProfile: 'local_nonpublishable' | 'public_unsigned_alpha';
  readonly source: string;
  readonly runtimeVersion: string;
  readonly coreSha256: string;
  readonly coreBytes: number;
  readonly installedManifestSha256: string;
  readonly candidateManifestSha256: string;
  readonly manifestIdentitySha256: string;
  readonly workerSha256: string;
  readonly workerBytes: number;
}

export interface AcceptanceInstalledArtifactProvenance {
  readonly executableName: string;
  readonly executableSha256: string;
  readonly executableBytes: number;
  readonly runtimeVersion: string;
  readonly runtimeCoreName: string;
  readonly runtimeCoreSha256: string;
  readonly runtimeCoreBytes: number;
  readonly runtimeManifestSha256: string;
  readonly runtimeManifestIdentitySha256: string;
}

interface RuntimeIdentity {
  readonly root: string;
  readonly runtimeVersion: string;
  readonly fileName: string;
  readonly coreSha256: string;
  readonly coreBytes: number;
  readonly manifestSha256: string;
  readonly manifestIdentitySha256: string;
}

interface CandidateRuntime {
  readonly root: string;
  readonly provenance: Omit<AcceptanceRuntimeProvenance, 'workerSha256' | 'workerBytes'>;
  readonly worker: {
    readonly fileName: string;
    readonly sha256: string;
    readonly bytes: number;
  };
}

interface CaptureRuntimeMirror {
  readonly url: string;
  readonly workerSha256: string;
  readonly workerBytes: number;
  readonly workerArchive: Uint8Array;
  readonly close: () => Promise<void>;
}

interface AcceptanceSmokeOptionsDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly workspaceRoot?: string;
  readonly defaultImagePath?: string;
  readonly createAppDataDirectory?: typeof createAcceptanceAppDataDirectory;
  readonly removeAppDataDirectory?: typeof removeAcceptanceAppDataDirectory;
}

export function defaultAcceptanceImagePath(
  workspaceRoot = resolve(import.meta.dirname, '../..', '..'),
): string {
  return resolve(
    workspaceRoot,
    '..',
    'capture-workbench',
    'test-fixtures',
    'ocr_test_image.jpeg',
  );
}

export async function createAcceptanceSmokeOptions(
  dependencies: AcceptanceSmokeOptionsDependencies = {},
): Promise<{
  run: AcceptanceRun;
  options: SmokeOptions;
  imageOptions: PackagedImageUploadSmokeOptions;
  fixtures: {
    pdf: AcceptanceFixture;
    image: AcceptanceFixture;
  };
  appDataDirectories: readonly string[];
  installedArtifact: AcceptanceInstalledArtifactProvenance;
  runtimeProvenance?: AcceptanceRuntimeProvenance;
  captureRuntimeMirror?: CaptureRuntimeMirror;
}> {
  const environment = dependencies.environment ?? process.env;
  const createAppDataDirectory =
    dependencies.createAppDataDirectory ?? createAcceptanceAppDataDirectory;
  const removeAppDataDirectory =
    dependencies.removeAppDataDirectory ?? removeAcceptanceAppDataDirectory;
  const workspaceRoot = resolve(
    dependencies.workspaceRoot ?? resolve(import.meta.dirname, '../..', '..'),
  );
  const run = createAcceptanceRun(environment, 'cert-prep', workspaceRoot);
  const provider = (environment['CERT_PREP_PACKAGE_SMOKE_LLM_PROVIDER'] || '')
    .trim()
    .toLowerCase();
  if (provider !== 'fake') {
    throw new Error(
      'CERT_PREP_PACKAGE_SMOKE_LLM_PROVIDER must be explicitly set to fake for host structuring acceptance.',
    );
  }
  const exePath = await requiredFile(
    'CERT_PREP_ACCEPTANCE_EXE',
    'packaged executable',
    environment,
  );
  const pdfPath = await requiredFile(
    'CERT_PREP_ACCEPTANCE_PDF',
    'PDF fixture',
    environment,
  );
  const imagePath = await requiredFileValue(
    environment['CERT_PREP_ACCEPTANCE_IMAGE']?.trim() ||
      dependencies.defaultImagePath ||
      defaultAcceptanceImagePath(workspaceRoot),
    'JPEG/image fixture',
    'CERT_PREP_ACCEPTANCE_IMAGE',
  );
  const expectedTextIncludes = await loadImageTextExpectation(
    imagePath,
    environment,
  );
  const installedRuntime = await loadInstalledRuntimeIdentity(exePath);
  const installedExe = await stat(exePath);
  const installedArtifact: AcceptanceInstalledArtifactProvenance = {
    executableName: basename(exePath),
    executableSha256: await sha256File(exePath),
    executableBytes: installedExe.size,
    runtimeVersion: installedRuntime.runtimeVersion,
    runtimeCoreName: installedRuntime.fileName,
    runtimeCoreSha256: installedRuntime.coreSha256,
    runtimeCoreBytes: installedRuntime.coreBytes,
    runtimeManifestSha256: installedRuntime.manifestSha256,
    runtimeManifestIdentitySha256: installedRuntime.manifestIdentitySha256,
  };
  const candidateRuntime = await loadRuntimeCandidate(
    environment,
    installedRuntime,
  );
  const actualSha256 = await sha256File(pdfPath);
  const packagedRunRoot = join(run.artifactRoot, 'packaged-run');
  const options = parsePackagedFlowSmokeArgs(
    [
      '--exe',
      exePath,
      '--pdf',
      pdfPath,
      '--out-dir',
      packagedRunRoot,
      '--llm-provider',
      provider,
    ],
    workspaceRoot,
    environment,
  );

  let captureRuntimeMirror: CaptureRuntimeMirror | undefined;
  const appDataDirectories: string[] = [];
  try {
    captureRuntimeMirror = candidateRuntime
      ? await startCaptureRuntimeMirror(candidateRuntime)
      : undefined;
    appDataDirectories.push(
      createAppDataDirectory(workspaceRoot, run.runId, 'pdf'),
    );
    appDataDirectories.push(
      createAppDataDirectory(workspaceRoot, run.runId, 'image'),
    );
    if (captureRuntimeMirror) {
      for (const appDataDirectory of appDataDirectories) {
        assertDownloadedWorkerPathBudget(
          appDataDirectory,
          candidateRuntime?.provenance.runtimeVersion ?? installedRuntime.runtimeVersion,
          captureRuntimeMirror.workerArchive,
        );
      }
    }
    const runtimeProvenance = candidateRuntime && captureRuntimeMirror
      ? {
          ...candidateRuntime.provenance,
          workerSha256: captureRuntimeMirror.workerSha256,
          workerBytes: captureRuntimeMirror.workerBytes,
        }
      : undefined;
    const pdfOutDir = join(packagedRunRoot, 'pdf-ocr-run');
    const imageOptions: PackagedImageUploadSmokeOptions = {
      workspaceRoot,
      exePath,
      outDir: join(packagedRunRoot, 'image-ocr-run'),
      appDataDir: appDataDirectories[1],
      cdpPort: options.cdpPort + 3,
      timeoutMs: Math.max(options.streamingCompleteTimeoutMs, 300_000),
      acceptanceIsolation: true,
      ...(captureRuntimeMirror
        ? { captureRuntimeWorkerMirrorUrl: captureRuntimeMirror.url }
        : {}),
      acceptanceArtifactRoot: run.artifactRoot,
      imagePath,
      expectedTextIncludes,
      languageHint: 'en',
      llmProvider: provider,
    };
    return {
      run,
      options: {
        ...options,
        outDir: pdfOutDir,
        appDataDir: appDataDirectories[0],
        acceptanceArtifactRoot: run.artifactRoot,
        acceptanceIsolation: true,
        acceptanceRecordVideo: run.recordVideo,
        acceptanceVerifyMarkdownExport: true,
        ...(captureRuntimeMirror
          ? { captureRuntimeWorkerMirrorUrl: captureRuntimeMirror.url }
          : {}),
        ...(runtimeProvenance
          ? { candidateDistributionProfile: runtimeProvenance.distributionProfile }
          : {}),
      },
      imageOptions,
      fixtures: {
        pdf: { name: basename(pdfPath), sha256: actualSha256 },
        image: {
          name: basename(imagePath),
          sha256: await sha256File(imagePath),
          expectedTextIncludes,
        },
      },
      appDataDirectories,
      installedArtifact,
      runtimeProvenance,
      captureRuntimeMirror,
    };
  } catch (error) {
    for (const appDataDirectory of appDataDirectories) {
      removeAppDataDirectory(workspaceRoot, appDataDirectory);
    }
    await captureRuntimeMirror?.close();
    throw error;
  }
}

async function loadInstalledRuntimeIdentity(
  exePath: string,
): Promise<RuntimeIdentity> {
  const resourceRoot = join(dirname(exePath), 'resources');
  return loadRuntimeIdentity(resourceRoot, 'installed Capture Runtime');
}

async function loadRuntimeCandidate(
  environment: Readonly<NodeJS.ProcessEnv>,
  installedRuntime: RuntimeIdentity,
): Promise<CandidateRuntime | undefined> {
  const rootValue = environment['CERT_PREP_CAPTURE_RUNTIME_ROOT']?.trim();
  if (!rootValue) return undefined;

  const root = resolve(rootValue);
  const candidate = await loadRuntimeIdentity(root, 'Capture Runtime candidate');
  if (
    candidate.runtimeVersion !== installedRuntime.runtimeVersion ||
    candidate.fileName !== installedRuntime.fileName ||
    candidate.coreSha256 !== installedRuntime.coreSha256 ||
    candidate.coreBytes !== installedRuntime.coreBytes ||
    candidate.manifestIdentitySha256 !== installedRuntime.manifestIdentitySha256
  ) {
    throw new Error(
      'The installed application Capture Runtime does not exactly match CERT_PREP_CAPTURE_RUNTIME_ROOT.',
    );
  }
  const runtimeProfile = environment['CERT_PREP_ACCEPTANCE_RUNTIME_PROFILE']?.trim();
  if (runtimeProfile && runtimeProfile !== 'downloaded_public') {
    throw new Error(
      'CERT_PREP_ACCEPTANCE_RUNTIME_PROFILE must be downloaded_public when supplied.',
    );
  }
  const downloadedPublic = runtimeProfile === 'downloaded_public';
  const worker = await loadCatalogWorker(root, candidate.runtimeVersion);
  return {
    root,
    provenance: {
      distributionProfile: downloadedPublic
        ? 'public_unsigned_alpha'
        : 'local_nonpublishable',
      source: downloadedPublic
        ? `downloaded Capture Runtime ${candidate.runtimeVersion} release package (installed core match and catalog-bound worker)`
        : 'Capture Runtime candidate with exact installed core match and catalog-bound worker',
      runtimeVersion: candidate.runtimeVersion,
      coreSha256: candidate.coreSha256,
      coreBytes: candidate.coreBytes,
      installedManifestSha256: installedRuntime.manifestSha256,
      candidateManifestSha256: candidate.manifestSha256,
      manifestIdentitySha256: candidate.manifestIdentitySha256,
    },
    worker,
  };
}

async function loadRuntimeIdentity(
  root: string,
  label: string,
): Promise<RuntimeIdentity> {
  const manifestPath = join(root, 'capture-runtime-manifest.json');
  const manifestBytes = await readFile(manifestPath).catch(() => {
    throw new Error(
      `${label} must contain capture-runtime-manifest.json: ${manifestPath}.`,
    );
  });
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} manifest is not valid JSON: ${manifestPath}.`, {
      cause: error,
    });
  }
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest)
  ) {
    throw new Error(`${label} manifest must be a JSON object.`);
  }
  const record = manifest as Record<string, unknown>;
  const runtimeVersion = record.runtimeVersion;
  const fileName = record.fileName;
  const expectedSha256 = record.sha256;
  const expectedBytes = record.bytes;
  if (
    typeof runtimeVersion !== 'string' ||
    typeof fileName !== 'string' ||
    !/^[A-Za-z0-9._-]+$/u.test(fileName) ||
    typeof expectedSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/iu.test(expectedSha256) ||
    typeof expectedBytes !== 'number' ||
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes <= 0
  ) {
    throw new Error(`${label} manifest has invalid provenance fields.`);
  }
  const corePath = join(root, fileName);
  const core = await readFile(corePath).catch(() => {
    throw new Error(`${label} core is not readable: ${corePath}.`);
  });
  const coreSha256 = createHash('sha256').update(core).digest('hex');
  if (core.length !== expectedBytes || coreSha256 !== expectedSha256.toLowerCase()) {
    throw new Error(
      `${label} core does not match its manifest: ${corePath}.`,
    );
  }
  return {
    root,
    runtimeVersion,
    fileName,
    coreSha256,
    coreBytes: core.length,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    manifestIdentitySha256: createHash('sha256')
      .update(canonicalJson(record))
      .digest('hex'),
  };
}

async function loadCatalogWorker(
  root: string,
  runtimeVersion: string,
): Promise<CandidateRuntime['worker']> {
  const catalogPath = join(root, 'capture-engine-catalog.downloaded.json');
  const contents = await readFile(catalogPath, 'utf8').catch(() => {
    throw new Error(
      `Capture Runtime candidate must contain the downloaded engine catalog: ${catalogPath}.`,
    );
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Capture Runtime engine catalog is not valid JSON: ${catalogPath}.`, {
      cause: error,
    });
  }
  if (!isRecord(parsed) || parsed.runtimeVersion !== runtimeVersion) {
    throw new Error('Capture Runtime engine catalog runtimeVersion is invalid.');
  }
  const requirements = Array.isArray(parsed.requirements) ? parsed.requirements : [];
  const ocrRequirement = requirements.find(
    (value) => isRecord(value) && value.requirementId === 'windowsml-ocr',
  );
  const artifacts = isRecord(ocrRequirement) && Array.isArray(ocrRequirement.artifacts)
    ? ocrRequirement.artifacts
    : [];
  const artifact = artifacts.length === 1 && isRecord(artifacts[0])
    ? artifacts[0]
    : undefined;
  const expectedName = `capture-engine-ocr-${runtimeVersion}-windows-x64.zip`;
  if (
    !artifact ||
    artifact.fileName !== expectedName ||
    typeof artifact.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/iu.test(artifact.sha256) ||
    typeof artifact.bytes !== 'number' ||
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes <= 0
  ) {
    throw new Error('Capture Runtime engine catalog has no valid WindowsML OCR worker.');
  }
  const workerPath = join(root, expectedName);
  const worker = await readFile(workerPath).catch(() => {
    throw new Error(`Capture Runtime OCR worker is not readable: ${workerPath}.`);
  });
  const workerSha256 = createHash('sha256').update(worker).digest('hex');
  if (worker.length !== artifact.bytes || workerSha256 !== artifact.sha256.toLowerCase()) {
    throw new Error('Capture Runtime OCR worker does not match the downloaded catalog.');
  }
  return { fileName: expectedName, sha256: workerSha256, bytes: worker.length };
}

async function startCaptureRuntimeMirror(
  candidate: CandidateRuntime,
): Promise<CaptureRuntimeMirror> {
  const workerName = candidate.worker.fileName;
  const workerPath = join(candidate.root, workerName);
  const worker = await readFile(workerPath);
  const workerSha256 = createHash('sha256').update(worker).digest('hex');
  if (
    workerSha256 !== candidate.worker.sha256 ||
    worker.length !== candidate.worker.bytes
  ) {
    throw new Error('Capture Runtime OCR worker changed after catalog validation.');
  }
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(
      new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
    );
    if (request.method !== 'GET' || pathname !== `/${workerName}`) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Length', String(worker.length));
    // Serve the immutable bytes that were catalog-validated above. Reopening
    // the path here would create a validation-to-download drift window.
    response.end(worker);
  });
  const address = await new Promise<AddressInfo>(
    (resolveAddress, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const value = server.address();
        if (!value || typeof value === 'string') {
          reject(new Error('Capture Runtime worker mirror did not expose a TCP address.'));
          return;
        }
        resolveAddress(value);
      });
    },
  );
  return {
    url: `http://127.0.0.1:${address.port}`,
    workerSha256,
    workerBytes: worker.length,
    workerArchive: worker,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}

async function requiredFile(
  name: string,
  label: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<string> {
  return requiredFileValue(requiredValue(name, environment), label, name);
}

async function requiredFileValue(
  value: string,
  label: string,
  name: string,
): Promise<string> {
  const resolved = resolve(value);
  const metadata = await stat(resolved).catch(() => undefined);
  if (!metadata?.isFile() || metadata.size === 0) {
    throw new Error(`${name} must point to a non-empty ${label}: ${resolved}.`);
  }
  return resolved;
}

function requiredValue(
  name: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): string {
  const value = environment[name]?.trim();
  if (!value)
    throw new Error(`${name} must be set explicitly for real acceptance.`);
  return value;
}

async function loadImageTextExpectation(
  imagePath: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  defaultExpectationPath = `${imagePath}.expected.json`,
): Promise<readonly string[]> {
  const expectationPath =
    environment['CERT_PREP_ACCEPTANCE_IMAGE_EXPECTATIONS']?.trim() ||
    defaultExpectationPath;
  const contents = await readFile(expectationPath, 'utf8').catch(() => {
    throw new Error(
      `CERT_PREP_ACCEPTANCE_IMAGE_EXPECTATIONS must identify a readable expectation manifest: ${resolve(expectationPath)}.`,
    );
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Image OCR expectation manifest is not valid JSON: ${resolve(expectationPath)}.`,
      { cause: error },
    );
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    throw new Error('Image OCR expectation manifest must be a JSON object.');
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw new Error('Image OCR expectation manifest schemaVersion must be 1.');
  }
  if (
    record.sourceFileName !== undefined &&
    (typeof record.sourceFileName !== 'string' ||
      record.sourceFileName.toLowerCase() !== basename(imagePath).toLowerCase())
  ) {
    throw new Error(
      'Image OCR expectation sourceFileName must identify the selected image.',
    );
  }
  if (
    !Array.isArray(record.rawTextIncludes) ||
    record.rawTextIncludes.length === 0 ||
    record.rawTextIncludes.some(
      (value) => typeof value !== 'string' || normalizeOcrText(value).length === 0,
    )
  ) {
    throw new Error(
      'Image OCR expectation rawTextIncludes must contain non-empty text anchors.',
    );
  }
  const anchors = record.rawTextIncludes.map((value) => normalizeOcrText(String(value)));
  if (new Set(anchors).size !== anchors.length) {
    throw new Error('Image OCR expectation text anchors must be unique.');
  }
  return anchors;
}

function normalizeOcrText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
