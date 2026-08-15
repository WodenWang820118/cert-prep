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
  validateCaptureArtifactBytes,
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
import {
  CAPTURE_RUNTIME_ROOT_ENV,
  defaultCaptureRuntimeRoot,
} from '../../../tools/install-capture-runtime.mts';

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
}

interface PrepareRuntimeResourcesOptions {
  readonly workspaceRoot: string;
  readonly mode: RuntimeResourceMode;
  readonly outputDir?: string;
  readonly backendRuntimeRoot?: string;
  readonly captureRuntimeManifestPath?: string;
  readonly captureRuntimeArtifactPath?: string;
  readonly captureDocumentSchemaPath?: string;
  readonly captureRuntimeRoot?: string;
}

interface PreparedRuntimeResources {
  readonly outputDir: string;
  readonly backendManifestPath: string;
  readonly backendArtifactPath: string;
  readonly captureRuntimeManifestPath: string;
  readonly captureRuntimeArtifactPath: string;
  readonly captureDocumentSchemaPath: string;
  readonly releaseMetadataPath: string;
}

/**
 * Produces the resource directory consumed by Tauri.
 *
 * cert-prep owns only the backend sidecar here. Capture Runtime is staged as
 * its published executable, manifest, and schema; its WindowsML bundle
 * descriptor and model lifecycle remain inside Capture Runtime and are
 * verified by the runtime itself without extracting or rebuilding a cert-prep
 * OCR payload.
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
  captureRuntimeManifestPath,
  captureRuntimeArtifactPath,
  captureDocumentSchemaPath,
  captureRuntimeRoot,
}: PrepareRuntimeResourcesOptions): Promise<PreparedRuntimeResources> {
  const backendSourceManifest = join(
    backendRuntimeRoot,
    'backend-runtime-manifest.json',
  );
  const backendManifest = await loadAndVerifyManifest(
    backendSourceManifest,
    backendRuntimeRoot,
    'python_backend',
  );
  const captureRuntimeInputs = resolveCaptureRuntimeInputs({
    workspaceRoot,
    captureRuntimeRoot,
    captureRuntimeManifestPath,
    captureRuntimeArtifactPath,
    captureDocumentSchemaPath,
  });
  const captureRuntimeManifest = await loadAndVerifyCaptureRuntime(
    captureRuntimeInputs.manifestPath,
    captureRuntimeInputs.artifactPath,
    captureRuntimeInputs.schemaPath,
  );

  const backendSourceArtifact = join(
    backendRuntimeRoot,
    backendManifest.artifact.file_name,
  );
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

  const stagedCaptureRuntimeArtifactPath = join(
    outputDir,
    captureRuntimeManifest.fileName,
  );
  copyFileSync(
    requiredStagedPath(
      captureRuntimeInputs.artifactPath,
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
      captureRuntimeInputs.schemaPath,
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
  writeJson(
    releaseMetadataPath,
    releaseMetadata(mode, backendManifest, captureRuntimeManifest),
  );

  return {
    outputDir,
    backendManifestPath,
    backendArtifactPath,
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
      `${environmentName} is required; run cert-prep-desktop:install-capture-runtime before preparing Tauri resources.`,
    );
  }
  return trimmed;
}

interface CaptureRuntimeInputs {
  readonly manifestPath: string;
  readonly artifactPath: string;
  readonly schemaPath: string;
}

function resolveCaptureRuntimeInputs({
  workspaceRoot,
  captureRuntimeRoot,
  captureRuntimeManifestPath,
  captureRuntimeArtifactPath,
  captureDocumentSchemaPath,
}: Pick<
  PrepareRuntimeResourcesOptions,
  | 'workspaceRoot'
  | 'captureRuntimeRoot'
  | 'captureRuntimeManifestPath'
  | 'captureRuntimeArtifactPath'
  | 'captureDocumentSchemaPath'
>): CaptureRuntimeInputs {
  const explicitManifest =
    captureRuntimeManifestPath ?? process.env[CAPTURE_RUNTIME_MANIFEST_PATH_ENV];
  const explicitArtifact =
    captureRuntimeArtifactPath ?? process.env[CAPTURE_RUNTIME_ARTIFACT_PATH_ENV];
  const explicitSchema =
    captureDocumentSchemaPath ?? process.env[CAPTURE_DOCUMENT_SCHEMA_PATH_ENV];
  if (explicitManifest || explicitArtifact || explicitSchema) {
    return {
      manifestPath: requiredStagedPath(
        explicitManifest,
        CAPTURE_RUNTIME_MANIFEST_PATH_ENV,
      ),
      artifactPath: requiredStagedPath(
        explicitArtifact,
        CAPTURE_RUNTIME_ARTIFACT_PATH_ENV,
      ),
      schemaPath: requiredStagedPath(
        explicitSchema,
        CAPTURE_DOCUMENT_SCHEMA_PATH_ENV,
      ),
    };
  }
  const root = resolve(
    workspaceRoot,
    captureRuntimeRoot ??
      process.env[CAPTURE_RUNTIME_ROOT_ENV] ??
      defaultCaptureRuntimeRoot(workspaceRoot),
  );
  return {
    manifestPath: join(root, 'capture-runtime-manifest.json'),
    artifactPath: join(root, CAPTURE_RUNTIME_FILE),
    schemaPath: join(root, CAPTURE_DOCUMENT_SCHEMA_FILE),
  };
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
    ['schemaSha256', manifest.schemaSha256, CAPTURE_DOCUMENT_SCHEMA_SHA256],
  ];
  for (const [name, actual, expected] of exactFields) {
    if (actual !== expected) {
      throw new Error(
        `Capture runtime ${name} must be ${expected}, found ${String(actual)}.`,
      );
    }
  }
  validateCaptureArtifactBytes(manifest.bytes, 'Capture runtime executable');
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
  if (artifact.size !== manifest.bytes) {
    throw new Error(
      `Capture runtime artifact size mismatch: expected ${manifest.bytes}, found ${artifact.size}.`,
    );
  }
  if ((await sha256File(artifactPath)) !== manifest.sha256.toLowerCase()) {
    throw new Error('Capture runtime artifact checksum mismatch.');
  }
  const schema = statSync(schemaPath);
  if (!schema.isFile()) {
    throw new Error('Capture document schema must be a regular file.');
  }
  if ((await sha256File(schemaPath)) !== CAPTURE_DOCUMENT_SCHEMA_SHA256) {
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
    schema['title'] !== 'CaptureDocument' ||
    schema['type'] !== 'object' ||
    schema['additionalProperties'] !== false ||
    schemaVersionConst !== CAPTURE_DOCUMENT_SCHEMA_VERSION
  ) {
    throw new Error(
      'Capture document schema does not declare the pinned CaptureDocument contract.',
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
    throw new Error(`Invalid ${expectedKind} runtime manifest: ${manifestPath}`);
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
  const expectedArtifactName = `cert-prep-backend-runtime-${ALPHA_VERSION}-${manifest.target}.zip`;
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
  if ((await sha256File(artifactPath)) !== manifest.artifact.sha256.toLowerCase()) {
    throw new Error(`${expectedKind} artifact checksum mismatch.`);
  }
  return manifest as RuntimeManifest;
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
        ? 'Compare the bundled runtime ZIPs with the SHA-256 values in their manifests.'
        : 'Compare Get-FileHash -Algorithm SHA256 output with the SHA256SUMS.txt value published on the same GitHub Release.',
    },
    runtime_assets: {
      backend: {
        distribution: 'bundled',
        file_name: backend.artifact.file_name,
        sha256: backend.artifact.sha256,
        bytes: backend.artifact.bytes,
      },
      capture_runtime: {
        distribution: 'versioned_release_artifact_staged',
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

function parseArgs(args: readonly string[]): {
  readonly mode: RuntimeResourceMode;
  readonly captureRuntimeManifestPath?: string;
  readonly captureRuntimeArtifactPath?: string;
  readonly captureDocumentSchemaPath?: string;
  readonly captureRuntimeRoot?: string;
} {
  let mode: RuntimeResourceMode | undefined;
  let captureRuntimeManifestPath: string | undefined;
  let captureRuntimeArtifactPath: string | undefined;
  let captureDocumentSchemaPath: string | undefined;
  let captureRuntimeRoot: string | undefined;
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
    } else if (arg === '--capture-runtime-manifest') {
      captureRuntimeManifestPath = next();
    } else if (arg === '--capture-runtime-artifact') {
      captureRuntimeArtifactPath = next();
    } else if (arg === '--capture-document-schema') {
      captureDocumentSchemaPath = next();
    } else if (arg === '--capture-runtime-root') {
      captureRuntimeRoot = next();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!mode) throw new Error('--mode is required.');
  return {
    mode,
    captureRuntimeManifestPath,
    captureRuntimeArtifactPath,
    captureDocumentSchemaPath,
    captureRuntimeRoot,
  };
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const workspaceRoot = resolve(scriptDir, '../../..');
  const args = parseArgs(process.argv.slice(2));
  const result = await prepareRuntimeResources({
    workspaceRoot,
    mode: args.mode,
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
    captureRuntimeRoot: resolveStagedInput(
      workspaceRoot,
      args.captureRuntimeRoot ?? process.env[CAPTURE_RUNTIME_ROOT_ENV],
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
