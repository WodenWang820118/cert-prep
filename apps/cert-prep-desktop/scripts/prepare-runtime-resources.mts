import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type CaptureRuntimeBundleRequirement,
  validateCaptureArtifactBytes,
  validateCaptureWindowsmlDescriptor,
} from './capture-runtime-contract.mts';
import {
  ALPHA_VERSION,
  CAPTURE_DOCUMENT_SCHEMA_FILE,
  CAPTURE_DOCUMENT_SCHEMA_SHA256,
  CAPTURE_DOCUMENT_SCHEMA_VERSION,
  CAPTURE_RUNTIME_API_VERSION,
  CAPTURE_RUNTIME_FILE,
  CAPTURE_RUNTIME_MANIFEST_VERSION,
  CAPTURE_RUNTIME_VERSION,
  PYTHON_RUNTIME_VERSION,
} from './package-qa/constants.mts';

const WINDOWSML_RELEASE_BASE_URL_ENV = 'CERT_PREP_WINDOWSML_OCR_ASSET_BASE_URL';
const CAPTURE_RUNTIME_MANIFEST_PATH_ENV =
  'CERT_PREP_CAPTURE_RUNTIME_MANIFEST_PATH';
const CAPTURE_RUNTIME_ARTIFACT_PATH_ENV =
  'CERT_PREP_CAPTURE_RUNTIME_ARTIFACT_PATH';
const CAPTURE_DOCUMENT_SCHEMA_PATH_ENV =
  'CERT_PREP_CAPTURE_DOCUMENT_SCHEMA_PATH';
const ALPHA_RELEASE_TAG = `cert-prep-v${ALPHA_VERSION}`;

type RuntimeResourceMode = 'dev' | 'release';

interface RuntimeManifest {
  readonly schema_version?: number;
  readonly kind: string;
  readonly version: string;
  readonly target: string;
  readonly entrypoint: string;
  readonly artifact: {
    readonly file_name: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly url?: string | null;
  };
}

interface CaptureRuntimeManifest {
  readonly manifestVersion: string;
  readonly runtimeVersion: string;
  readonly apiVersion: string;
  readonly captureDocumentSchemaVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly schemaFileName: string;
  readonly schemaSha256: string;
  readonly runtimeRequirements: {
    readonly 'windowsml-ocr': CaptureRuntimeBundleRequirement;
  };
}

interface PrepareRuntimeResourcesOptions {
  readonly workspaceRoot: string;
  readonly mode: RuntimeResourceMode;
  readonly outputDir?: string;
  readonly backendRuntimeRoot?: string;
  readonly windowsmlRuntimeRoot?: string;
  readonly windowsmlReleaseBaseUrl?: string;
  readonly captureRuntimeManifestPath?: string;
  readonly captureRuntimeArtifactPath?: string;
  readonly captureDocumentSchemaPath?: string;
}

interface PreparedRuntimeResources {
  readonly outputDir: string;
  readonly backendManifestPath: string;
  readonly backendArtifactPath: string;
  readonly windowsmlManifestPath: string;
  readonly captureRuntimeManifestPath: string;
  readonly captureRuntimeArtifactPath: string;
  readonly captureDocumentSchemaPath: string;
  readonly releaseMetadataPath: string;
}

/**
 * Produces the only resource directory consumed by Tauri.
 *
 * Release mode is fail-closed: the backend is bundled and the OCR URL must be
 * an HTTPS GitHub Release URL. Dev mode is deliberately separate and may use a
 * local file URL for the large OCR artifact.
 */
export async function prepareRuntimeResources({
  workspaceRoot,
  mode,
  outputDir = join(
    workspaceRoot,
    'apps/cert-prep-desktop/src-tauri/generated-resources',
  ),
  backendRuntimeRoot = join(
    workspaceRoot,
    'apps/cert-prep-backend/dist/backend-runtime',
  ),
  windowsmlRuntimeRoot = join(
    workspaceRoot,
    'apps/cert-prep-backend/dist/ocr-windowsml-runtime',
  ),
  windowsmlReleaseBaseUrl,
  captureRuntimeManifestPath,
  captureRuntimeArtifactPath,
  captureDocumentSchemaPath,
}: PrepareRuntimeResourcesOptions): Promise<PreparedRuntimeResources> {
  const backendSourceManifest = join(
    backendRuntimeRoot,
    'backend-runtime-manifest.json',
  );
  const windowsmlSourceManifest = join(
    windowsmlRuntimeRoot,
    'windowsml-ocr-runtime-manifest.json',
  );
  const backendManifest = await loadAndVerifyManifest(
    backendSourceManifest,
    backendRuntimeRoot,
    'python_backend',
  );
  const windowsmlManifest = await loadAndVerifyManifest(
    windowsmlSourceManifest,
    windowsmlRuntimeRoot,
    'windowsml_ocr',
  );
  const captureRuntimeManifest = await loadAndVerifyCaptureRuntime(
    requiredStagedPath(
      captureRuntimeManifestPath,
      CAPTURE_RUNTIME_MANIFEST_PATH_ENV,
    ),
    requiredStagedPath(
      captureRuntimeArtifactPath,
      CAPTURE_RUNTIME_ARTIFACT_PATH_ENV,
    ),
    requiredStagedPath(
      captureDocumentSchemaPath,
      CAPTURE_DOCUMENT_SCHEMA_PATH_ENV,
    ),
  );

  const backendSourceArtifact = join(
    backendRuntimeRoot,
    backendManifest.artifact.file_name,
  );
  const windowsmlSourceArtifact = join(
    windowsmlRuntimeRoot,
    windowsmlManifest.artifact.file_name,
  );
  const windowsmlUrl =
    mode === 'release'
      ? releaseAssetUrl(
          windowsmlReleaseBaseUrl ??
            process.env[WINDOWSML_RELEASE_BASE_URL_ENV],
          windowsmlManifest.artifact.file_name,
        )
      : pathToFileURL(windowsmlSourceArtifact).href;

  mkdirSync(outputDir, { recursive: true });
  for (const entry of readdirSync(outputDir, { withFileTypes: true })) {
    if (entry.name !== '.gitkeep') {
      rmSync(join(outputDir, entry.name), { recursive: true, force: true });
    }
  }

  const backendArtifactPath = join(
    outputDir,
    backendManifest.artifact.file_name,
  );
  copyFileSync(backendSourceArtifact, backendArtifactPath);
  const backendManifestPath = join(outputDir, 'backend-runtime-manifest.json');
  writeManifest(backendManifestPath, {
    ...backendManifest,
    artifact: { ...backendManifest.artifact, url: null },
  });

  const windowsmlManifestPath = join(
    outputDir,
    'windowsml-ocr-runtime-manifest.json',
  );
  writeManifest(windowsmlManifestPath, {
    ...windowsmlManifest,
    artifact: { ...windowsmlManifest.artifact, url: windowsmlUrl },
  });
  const stagedCaptureRuntimeArtifactPath = join(
    outputDir,
    captureRuntimeManifest.fileName,
  );
  copyFileSync(
    requiredStagedPath(
      captureRuntimeArtifactPath,
      CAPTURE_RUNTIME_ARTIFACT_PATH_ENV,
    ),
    stagedCaptureRuntimeArtifactPath,
  );
  const stagedCaptureDocumentSchemaPath = join(
    outputDir,
    captureRuntimeManifest.schemaFileName,
  );
  copyFileSync(
    requiredStagedPath(
      captureDocumentSchemaPath,
      CAPTURE_DOCUMENT_SCHEMA_PATH_ENV,
    ),
    stagedCaptureDocumentSchemaPath,
  );
  const stagedCaptureRuntimeManifestPath = join(
    outputDir,
    'capture-runtime-manifest.json',
  );
  writeJson(stagedCaptureRuntimeManifestPath, captureRuntimeManifest);
  const releaseMetadataPath = join(outputDir, 'release-metadata.json');
  writeFileSync(
    releaseMetadataPath,
    `${JSON.stringify(
      releaseMetadata(
        mode,
        backendManifest,
        windowsmlManifest,
        captureRuntimeManifest,
      ),
      null,
      2,
    )}\n`,
    'utf8',
  );

  return {
    outputDir,
    backendManifestPath,
    backendArtifactPath,
    windowsmlManifestPath,
    captureRuntimeManifestPath: stagedCaptureRuntimeManifestPath,
    captureRuntimeArtifactPath: stagedCaptureRuntimeArtifactPath,
    captureDocumentSchemaPath: stagedCaptureDocumentSchemaPath,
    releaseMetadataPath,
  };
}

function requiredStagedPath(
  value: string | undefined,
  environmentName: string,
): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(
      `${environmentName} is required; Capture runtime artifacts must be explicitly staged.`,
    );
  }
  return trimmed;
}

async function loadAndVerifyCaptureRuntime(
  manifestPath: string,
  artifactPath: string,
  schemaPath: string,
): Promise<CaptureRuntimeManifest> {
  if (!existsSync(manifestPath)) {
    throw new Error(`Capture runtime manifest was not staged: ${manifestPath}`);
  }
  if (!existsSync(artifactPath)) {
    throw new Error(`Capture runtime artifact was not staged: ${artifactPath}`);
  }
  if (!existsSync(schemaPath)) {
    throw new Error(`Capture document schema was not staged: ${schemaPath}`);
  }
  const manifest = JSON.parse(
    readFileSync(manifestPath, 'utf8'),
  ) as Partial<CaptureRuntimeManifest>;
  const exactFields: ReadonlyArray<readonly [string, unknown, string]> = [
    [
      'manifestVersion',
      manifest.manifestVersion,
      CAPTURE_RUNTIME_MANIFEST_VERSION,
    ],
    ['runtimeVersion', manifest.runtimeVersion, CAPTURE_RUNTIME_VERSION],
    ['apiVersion', manifest.apiVersion, CAPTURE_RUNTIME_API_VERSION],
    [
      'captureDocumentSchemaVersion',
      manifest.captureDocumentSchemaVersion,
      CAPTURE_DOCUMENT_SCHEMA_VERSION,
    ],
    ['platform', manifest.platform, 'windows'],
    ['arch', manifest.arch, 'x86_64'],
    ['fileName', manifest.fileName, CAPTURE_RUNTIME_FILE],
    [
      'schemaSha256',
      manifest.schemaSha256,
      CAPTURE_DOCUMENT_SCHEMA_SHA256,
    ],
  ];
  for (const [name, actual, expected] of exactFields) {
    if (actual !== expected) {
      throw new Error(
        `Capture runtime ${name} must be ${expected}, found ${String(actual)}.`,
      );
    }
  }
  validateCaptureArtifactBytes(
    manifest.bytes,
    'Capture runtime executable',
  );
  if (
    typeof manifest.sha256 !== 'string' ||
    !/^[a-fA-F0-9]{64}$/u.test(manifest.sha256)
  ) {
    throw new Error('Capture runtime sha256 must contain 64 hex characters.');
  }
  if (
    basename(artifactPath) !== manifest.fileName ||
    basename(manifest.fileName ?? '') !== manifest.fileName
  ) {
    throw new Error(
      `Capture runtime artifact must use the pinned ${CAPTURE_RUNTIME_FILE} file name.`,
    );
  }
  validateCaptureWindowsmlDescriptor(
    manifest.runtimeRequirements?.['windowsml-ocr'],
    'Capture runtime runtimeRequirements.windowsml-ocr',
  );
  if (
    manifest.schemaFileName !== CAPTURE_DOCUMENT_SCHEMA_FILE ||
    basename(schemaPath) !== CAPTURE_DOCUMENT_SCHEMA_FILE ||
    typeof manifest.schemaSha256 !== 'string'
  ) {
    throw new Error(
      `Capture runtime schema provenance must use the pinned ${CAPTURE_DOCUMENT_SCHEMA_FILE} artifact and SHA-256.`,
    );
  }
  const artifact = statSync(artifactPath);
  if (!artifact.isFile()) {
    throw new Error('Capture runtime artifact must be a regular file.');
  }
  const bytes = artifact.size;
  if (bytes !== manifest.bytes) {
    throw new Error(
      `Capture runtime artifact size mismatch: expected ${manifest.bytes}, found ${bytes}.`,
    );
  }
  const sha256 = await sha256File(artifactPath);
  if (sha256 !== manifest.sha256.toLowerCase()) {
    throw new Error('Capture runtime artifact checksum mismatch.');
  }
  const schema = statSync(schemaPath);
  if (!schema.isFile()) {
    throw new Error('Capture document schema must be a regular file.');
  }
  const schemaSha256 = await sha256File(schemaPath);
  if (schemaSha256 !== CAPTURE_DOCUMENT_SCHEMA_SHA256) {
    throw new Error('Capture document schema checksum mismatch.');
  }
  validateCaptureDocumentSchema(schemaPath);
  return manifest as CaptureRuntimeManifest;
}

function validateCaptureDocumentSchema(schemaPath: string): void {
  let schema: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(schemaPath, 'utf8')) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('schema root must be an object');
    }
    schema = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Capture document schema is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const properties = schema['properties'];
  const schemaVersion =
    properties && !Array.isArray(properties) && typeof properties === 'object'
      ? (properties as Record<string, unknown>)['schemaVersion']
      : undefined;
  const schemaVersionConst =
    schemaVersion &&
    !Array.isArray(schemaVersion) &&
    typeof schemaVersion === 'object'
      ? (schemaVersion as Record<string, unknown>)['const']
      : undefined;
  if (
    schema['$schema'] !== 'https://json-schema.org/draft/2020-12/schema' ||
    schema['title'] !== 'CaptureDocumentV1' ||
    schema['type'] !== 'object' ||
    schema['additionalProperties'] !== false ||
    schemaVersionConst !== CAPTURE_DOCUMENT_SCHEMA_VERSION
  ) {
    throw new Error(
      'Capture document schema does not declare the pinned CaptureDocumentV1 contract.',
    );
  }
}

async function loadAndVerifyManifest(
  manifestPath: string,
  runtimeRoot: string,
  expectedKind: string,
): Promise<RuntimeManifest> {
  if (!existsSync(manifestPath)) {
    throw new Error(`Runtime manifest was not built: ${manifestPath}`);
  }
  const manifest = JSON.parse(
    readFileSync(manifestPath, 'utf8'),
  ) as Partial<RuntimeManifest>;
  if (
    manifest.kind !== expectedKind ||
    typeof manifest.version !== 'string' ||
    typeof manifest.target !== 'string' ||
    typeof manifest.entrypoint !== 'string' ||
    !manifest.artifact ||
    typeof manifest.artifact.file_name !== 'string' ||
    typeof manifest.artifact.sha256 !== 'string' ||
    typeof manifest.artifact.bytes !== 'number'
  ) {
    throw new Error(
      `Invalid ${expectedKind} runtime manifest: ${manifestPath}`,
    );
  }
  if (manifest.version !== ALPHA_VERSION) {
    throw new Error(
      `${expectedKind} runtime version must be ${ALPHA_VERSION}, found ${manifest.version}.`,
    );
  }
  if (
    basename(manifest.artifact.file_name) !== manifest.artifact.file_name ||
    !manifest.artifact.file_name.endsWith('.zip')
  ) {
    throw new Error(
      `${expectedKind} artifact file_name must be a plain ZIP file name.`,
    );
  }
  const expectedArtifactName = `${
    expectedKind === 'python_backend'
      ? 'cert-prep-backend-runtime'
      : 'cert-prep-ocr-windowsml-runtime'
  }-${ALPHA_VERSION}-${manifest.target}.zip`;
  if (manifest.artifact.file_name !== expectedArtifactName) {
    throw new Error(
      `${expectedKind} artifact name must be ${expectedArtifactName}.`,
    );
  }
  const artifactPath = join(runtimeRoot, manifest.artifact.file_name);
  if (!existsSync(artifactPath)) {
    throw new Error(`Runtime artifact was not built: ${artifactPath}`);
  }
  const actualBytes = statSync(artifactPath).size;
  if (actualBytes !== manifest.artifact.bytes) {
    throw new Error(
      `${expectedKind} artifact size mismatch: expected ${manifest.artifact.bytes}, found ${actualBytes}.`,
    );
  }
  const actualHash = await sha256File(artifactPath);
  if (actualHash !== manifest.artifact.sha256.toLowerCase()) {
    throw new Error(`${expectedKind} artifact checksum mismatch.`);
  }
  return manifest as RuntimeManifest;
}

function releaseAssetUrl(
  baseUrlValue: string | undefined,
  fileName: string,
): string {
  const value = baseUrlValue?.trim();
  if (!value) {
    throw new Error(
      `${WINDOWSML_RELEASE_BASE_URL_ENV} is required in release mode.`,
    );
  }
  let url: URL;
  try {
    url = new URL(value.endsWith('/') ? value : `${value}/`);
  } catch {
    throw new Error(`${WINDOWSML_RELEASE_BASE_URL_ENV} must be a valid URL.`);
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/$/.test(url.pathname) ||
    !url.pathname.endsWith(`/releases/download/${ALPHA_RELEASE_TAG}/`)
  ) {
    throw new Error(
      `${WINDOWSML_RELEASE_BASE_URL_ENV} must use the ${ALPHA_RELEASE_TAG} GitHub Release URL.`,
    );
  }
  return new URL(encodeURIComponent(fileName), url).href;
}

function writeManifest(path: string, manifest: RuntimeManifest): void {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function releaseMetadata(
  mode: RuntimeResourceMode,
  backend: RuntimeManifest,
  windowsml: RuntimeManifest,
  captureRuntime: CaptureRuntimeManifest,
): object {
  const localNonpublishable = mode === 'dev';
  return {
    schema_version: 1,
    version: ALPHA_VERSION,
    python_runtime_version: PYTHON_RUNTIME_VERSION,
    release_tag: localNonpublishable
      ? `cert-prep-local-v${ALPHA_VERSION}`
      : ALPHA_RELEASE_TAG,
    channel: localNonpublishable
      ? 'local_nonpublishable'
      : 'unsigned_public_alpha',
    distribution_profile: localNonpublishable
      ? 'local_nonpublishable'
      : 'public_unsigned_alpha',
    publishable: !localNonpublishable,
    distribution_mode: mode,
    signed: false,
    platform: {
      os: 'windows',
      minimum_version: 'Windows 11',
      arch: 'x86_64',
      target: backend.target,
    },
    warnings: {
      smartscreen: localNonpublishable
        ? 'This local acceptance build is unsigned and cannot be published.'
        : 'This public Alpha is unsigned. Windows SmartScreen is expected to warn before installation.',
      production_ready: false,
    },
    sha256_verification: {
      required: true,
      algorithm: 'SHA-256',
      instruction: localNonpublishable
        ? 'Compare the local WindowsML OCR ZIP with the SHA-256 value in its bundled manifest.'
        : 'Compare Get-FileHash -Algorithm SHA256 output with the SHA256SUMS.txt value published on the same GitHub Release.',
    },
    runtime_assets: {
      backend: {
        distribution: 'bundled',
        file_name: backend.artifact.file_name,
        sha256: backend.artifact.sha256,
        bytes: backend.artifact.bytes,
      },
      windowsml_ocr: {
        distribution: localNonpublishable
          ? 'local_file'
          : 'github_release_download',
        file_name: windowsml.artifact.file_name,
        sha256: windowsml.artifact.sha256,
        bytes: windowsml.artifact.bytes,
      },
      capture_runtime: {
        distribution: 'explicit_staged_artifact',
        file_name: captureRuntime.fileName,
        runtime_version: captureRuntime.runtimeVersion,
        api_version: captureRuntime.apiVersion,
        capture_document_schema_version:
          captureRuntime.captureDocumentSchemaVersion,
        sha256: captureRuntime.sha256,
        bytes: captureRuntime.bytes,
        schema_file_name: captureRuntime.schemaFileName,
        schema_sha256: captureRuntime.schemaSha256,
        structuring_mode: 'host',
        runtime_requirements: captureRuntime.runtimeRequirements,
      },
    },
    legal_resources: {
      license: 'legal/LICENSE',
      privacy: 'legal/PRIVACY.md',
      changelog: 'legal/CHANGELOG.md',
      third_party_notices: 'legal/THIRD_PARTY_NOTICES.md',
    },
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

interface ParsedArgs {
  readonly mode: RuntimeResourceMode;
  readonly windowsmlReleaseBaseUrl?: string;
  readonly captureRuntimeManifestPath?: string;
  readonly captureRuntimeArtifactPath?: string;
  readonly captureDocumentSchemaPath?: string;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  let mode: RuntimeResourceMode | undefined;
  let windowsmlReleaseBaseUrl: string | undefined;
  let captureRuntimeManifestPath: string | undefined;
  let captureRuntimeArtifactPath: string | undefined;
  let captureDocumentSchemaPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = (): string => {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value.`);
      index += 1;
      return value;
    };
    if (arg === '--mode') {
      const value = next();
      if (value !== 'dev' && value !== 'release') {
        throw new Error('--mode must be dev or release.');
      }
      mode = value;
    } else if (arg === '--ocr-release-base-url') {
      windowsmlReleaseBaseUrl = next();
    } else if (arg === '--capture-runtime-manifest') {
      captureRuntimeManifestPath = next();
    } else if (arg === '--capture-runtime-artifact') {
      captureRuntimeArtifactPath = next();
    } else if (arg === '--capture-document-schema') {
      captureDocumentSchemaPath = next();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!mode) throw new Error('--mode is required.');
  return {
    mode,
    windowsmlReleaseBaseUrl,
    captureRuntimeManifestPath,
    captureRuntimeArtifactPath,
    captureDocumentSchemaPath,
  };
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const workspaceRoot = resolve(scriptDir, '../../..');
  const args = parseArgs(process.argv.slice(2));
  const result = await prepareRuntimeResources({
    workspaceRoot,
    mode: args.mode,
    windowsmlReleaseBaseUrl: args.windowsmlReleaseBaseUrl,
    captureRuntimeManifestPath: resolveStagedInput(
      workspaceRoot,
      args.captureRuntimeManifestPath ??
        process.env[CAPTURE_RUNTIME_MANIFEST_PATH_ENV],
    ),
    captureRuntimeArtifactPath: resolveStagedInput(
      workspaceRoot,
      args.captureRuntimeArtifactPath ??
        process.env[CAPTURE_RUNTIME_ARTIFACT_PATH_ENV],
    ),
    captureDocumentSchemaPath: resolveStagedInput(
      workspaceRoot,
      args.captureDocumentSchemaPath ??
        process.env[CAPTURE_DOCUMENT_SCHEMA_PATH_ENV],
    ),
  });
  console.log(
    `Prepared ${args.mode} runtime resources under ${result.outputDir}`,
  );
}

function resolveStagedInput(
  workspaceRoot: string,
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? resolve(workspaceRoot, trimmed) : undefined;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
