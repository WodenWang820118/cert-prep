import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import {
  validateCaptureArtifactBytes,
  validateCaptureWindowsmlDescriptor,
} from '../capture-runtime-contract.mts';
import {
  collectPackagedResourceArtifacts,
  publicFileRecord,
  sha256File,
} from './files.mts';
import type {
  CaptureRuntimeManifest,
  PackagedResourceContract,
  RuntimeManifest,
} from './types.mts';
import {
  ALPHA_VERSION,
  BACKEND_RUNTIME_PREFIX,
  CAPTURE_DOCUMENT_SCHEMA_FILE,
  CAPTURE_DOCUMENT_SCHEMA_SHA256,
  CAPTURE_DOCUMENT_SCHEMA_VERSION,
  CAPTURE_RUNTIME_API_VERSION,
  CAPTURE_RUNTIME_FILE,
  CAPTURE_RUNTIME_MANIFEST_VERSION,
  CAPTURE_RUNTIME_VERSION,
  DEFAULT_TARGET_TRIPLE,
  PYTHON_RUNTIME_VERSION,
  WINDOWSML_OCR_RUNTIME_PREFIX,
} from './constants.mts';

interface ValidateResourceContractOptions {
  readonly resourceRoot: string;
  readonly tauriConfig: string;
  readonly workspaceRoot: string;
  readonly expectedTargetTriple?: string;
}

/** Proves the hybrid distribution shape copied beside the packaged executable. */
export function validatePackagedResourceContract({
  resourceRoot,
  tauriConfig,
  workspaceRoot,
  expectedTargetTriple = DEFAULT_TARGET_TRIPLE,
}: ValidateResourceContractOptions): PackagedResourceContract {
  if (!existsSync(resourceRoot)) {
    throw new Error(
      `Packaged resource directory was not found: ${resourceRoot}`,
    );
  }
  validateTauriResourceMapping(tauriConfig);
  const backendManifestPath = join(
    resourceRoot,
    'backend-runtime-manifest.json',
  );
  const windowsmlManifestPath = join(
    resourceRoot,
    'windowsml-ocr-runtime-manifest.json',
  );
  const captureManifestPath = join(
    resourceRoot,
    'capture-runtime-manifest.json',
  );
  const backendManifest = loadAndValidateManifest(
    backendManifestPath,
    'python_backend',
    BACKEND_RUNTIME_PREFIX,
  );
  const windowsmlManifest = loadAndValidateManifest(
    windowsmlManifestPath,
    'windowsml_ocr',
    WINDOWSML_OCR_RUNTIME_PREFIX,
  );
  const captureManifest = loadAndValidateCaptureManifest(captureManifestPath);
  if (
    backendManifest.target !== expectedTargetTriple ||
    windowsmlManifest.target !== expectedTargetTriple
  ) {
    throw new Error(
      `Packaged runtime target must be ${expectedTargetTriple}; found backend=${backendManifest.target}, windowsml=${windowsmlManifest.target}.`,
    );
  }
  validateDistributionPolicy(backendManifest, windowsmlManifest);
  const files = collectPackagedResourceArtifacts(resourceRoot, workspaceRoot);
  const names = new Set(files.map((file) => basename(file.absolutePath)));
  for (const required of [
    'backend-runtime-manifest.json',
    backendManifest.artifact.file_name,
    'windowsml-ocr-runtime-manifest.json',
    'capture-runtime-manifest.json',
    captureManifest.fileName,
    captureManifest.schemaFileName,
    'release-metadata.json',
  ]) {
    if (!names.has(required)) {
      throw new Error(`Packaged runtime resource is missing: ${required}`);
    }
  }
  if (names.has(windowsmlManifest.artifact.file_name)) {
    throw new Error(
      `WindowsML OCR runtime must not be bundled: ${windowsmlManifest.artifact.file_name}`,
    );
  }
  const bundledZipNames = [...names].filter((name) => name.endsWith('.zip'));
  if (
    bundledZipNames.length !== 1 ||
    bundledZipNames[0] !== backendManifest.artifact.file_name
  ) {
    throw new Error(
      `Packaged resources must contain exactly the declared backend ZIP; found: ${bundledZipNames.join(', ') || 'none'}.`,
    );
  }
  validateBundledBackendArtifact(resourceRoot, backendManifest);
  validateBundledCaptureArtifacts(resourceRoot, captureManifest);
  const metadata = loadReleaseMetadata(
    join(resourceRoot, 'release-metadata.json'),
  );
  validateReleaseMetadata(
    metadata,
    backendManifest,
    windowsmlManifest,
    captureManifest,
  );
  const legalFiles = validateLegalResources(
    dirname(resourceRoot),
    workspaceRoot,
  );
  rejectDevelopmentReferences(
    resourceRoot,
    files.map((file) => file.absolutePath),
    workspaceRoot,
  );
  return {
    evidence_scope: 'static_tauri_release_resources',
    installer_contents_verified: false,
    fresh_install_verified: false,
    alpha_release_gate: 'blocked_pending_clean_install',
    backend_bundled: true,
    windowsml_ocr_bundled: false,
    capture_runtime_bundled: true,
    capture_runtime_version: CAPTURE_RUNTIME_VERSION,
    capture_runtime_api_version: CAPTURE_RUNTIME_API_VERSION,
    capture_document_schema_version: CAPTURE_DOCUMENT_SCHEMA_VERSION,
    capture_structuring_mode: 'host',
    release_urls_only: true,
    version: ALPHA_VERSION,
    python_runtime_version: PYTHON_RUNTIME_VERSION,
    channel: 'unsigned_public_alpha',
    signed: false,
    target: backendManifest.target,
    tauri_resource_mapping: 'generated-resources/* -> resources/ plus legal/*',
    resource_files: files.map(publicFileRecord),
    legal_files: legalFiles,
  };
}

function loadAndValidateCaptureManifest(path: string): CaptureRuntimeManifest {
  if (!existsSync(path)) {
    throw new Error('Packaged Capture runtime manifest is missing.');
  }
  const manifest = JSON.parse(
    readFileSync(path, 'utf8'),
  ) as Partial<CaptureRuntimeManifest>;
  if (
    manifest.manifestVersion !== CAPTURE_RUNTIME_MANIFEST_VERSION ||
    manifest.runtimeVersion !== CAPTURE_RUNTIME_VERSION ||
    manifest.apiVersion !== CAPTURE_RUNTIME_API_VERSION ||
    manifest.captureDocumentSchemaVersion !==
      CAPTURE_DOCUMENT_SCHEMA_VERSION ||
    manifest.platform !== 'windows' ||
    manifest.arch !== 'x86_64' ||
    manifest.fileName !== CAPTURE_RUNTIME_FILE ||
    basename(manifest.fileName ?? '') !== manifest.fileName ||
    typeof manifest.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/iu.test(manifest.sha256) ||
    manifest.schemaFileName !== CAPTURE_DOCUMENT_SCHEMA_FILE ||
    basename(manifest.schemaFileName ?? '') !== manifest.schemaFileName ||
    manifest.schemaSha256 !== CAPTURE_DOCUMENT_SCHEMA_SHA256
  ) {
    throw new Error('Invalid packaged Capture runtime manifest.');
  }
  validateCaptureArtifactBytes(
    manifest.bytes,
    'Packaged Capture runtime executable',
  );
  validateCaptureWindowsmlDescriptor(
    manifest.runtimeRequirements?.['windowsml-ocr'],
    'Packaged Capture runtime WindowsML requirement',
  );
  return manifest as CaptureRuntimeManifest;
}

function loadAndValidateManifest(
  path: string,
  expectedKind: string,
  artifactPrefix: string,
): RuntimeManifest {
  if (!existsSync(path)) {
    throw new Error(`Packaged runtime manifest is missing: ${basename(path)}`);
  }
  const manifest = JSON.parse(
    readFileSync(path, 'utf8'),
  ) as Partial<RuntimeManifest>;
  const artifact = manifest.artifact;
  if (
    manifest.kind !== expectedKind ||
    manifest.version !== ALPHA_VERSION ||
    typeof manifest.target !== 'string' ||
    manifest.target.trim() === '' ||
    typeof manifest.entrypoint !== 'string' ||
    manifest.entrypoint.trim() === '' ||
    !artifact ||
    typeof artifact.file_name !== 'string' ||
    basename(artifact.file_name) !== artifact.file_name ||
    artifact.file_name !== `${artifactPrefix}${manifest.target}.zip` ||
    typeof artifact.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes < 1
  ) {
    throw new Error(`Invalid packaged ${expectedKind} runtime manifest.`);
  }
  return manifest as RuntimeManifest;
}

function validateDistributionPolicy(
  backendManifest: RuntimeManifest,
  windowsmlManifest: RuntimeManifest,
): void {
  if (backendManifest.artifact.url !== null) {
    throw new Error('Bundled backend manifest must use artifact.url: null.');
  }
  const rawUrl = windowsmlManifest.artifact.url;
  if (typeof rawUrl !== 'string') {
    throw new Error('WindowsML OCR manifest must use a GitHub Release URL.');
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(
      'WindowsML OCR manifest must use a valid GitHub Release URL.',
    );
  }
  const expectedSuffix = `/releases/download/cert-prep-v${ALPHA_VERSION}/${encodeURIComponent(
    windowsmlManifest.artifact.file_name,
  )}`;
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/[^/]+\/[^/]+\/releases\/download\//.test(url.pathname) ||
    !url.pathname.endsWith(expectedSuffix)
  ) {
    throw new Error(
      'WindowsML OCR manifest must use the versioned GitHub Release URL.',
    );
  }
}

function validateBundledBackendArtifact(
  resourceRoot: string,
  manifest: RuntimeManifest,
): void {
  const artifactPath = join(resourceRoot, manifest.artifact.file_name);
  if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
    throw new Error('Declared bundled backend artifact is missing.');
  }
  if (statSync(artifactPath).size !== manifest.artifact.bytes) {
    throw new Error(
      'Bundled backend artifact byte count does not match its manifest.',
    );
  }
  if (sha256File(artifactPath) !== manifest.artifact.sha256.toLowerCase()) {
    throw new Error(
      'Bundled backend artifact checksum does not match its manifest.',
    );
  }
}

function validateBundledCaptureArtifacts(
  resourceRoot: string,
  manifest: CaptureRuntimeManifest,
): void {
  const executablePath = join(resourceRoot, manifest.fileName);
  if (!existsSync(executablePath) || !statSync(executablePath).isFile()) {
    throw new Error('Declared bundled Capture runtime executable is missing.');
  }
  if (statSync(executablePath).size !== manifest.bytes) {
    throw new Error(
      'Bundled Capture runtime byte count does not match its manifest.',
    );
  }
  if (sha256File(executablePath) !== manifest.sha256.toLowerCase()) {
    throw new Error(
      'Bundled Capture runtime checksum does not match its manifest.',
    );
  }

  const schemaPath = join(resourceRoot, manifest.schemaFileName);
  if (!existsSync(schemaPath) || !statSync(schemaPath).isFile()) {
    throw new Error('Declared bundled Capture document schema is missing.');
  }
  if (sha256File(schemaPath) !== CAPTURE_DOCUMENT_SCHEMA_SHA256) {
    throw new Error(
      'Bundled Capture document schema checksum does not match the pinned digest.',
    );
  }
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<
    string,
    unknown
  >;
  const schemaVersion = (
    (schema['properties'] as Record<string, unknown> | undefined)?.[
      'schemaVersion'
    ] as Record<string, unknown> | undefined
  )?.['const'];
  if (
    schema['$schema'] !== 'https://json-schema.org/draft/2020-12/schema' ||
    schema['title'] !== 'CaptureDocumentV1' ||
    schema['type'] !== 'object' ||
    schema['additionalProperties'] !== false ||
    schemaVersion !== CAPTURE_DOCUMENT_SCHEMA_VERSION
  ) {
    throw new Error(
      'Bundled Capture document schema does not declare the pinned CaptureDocumentV1 contract.',
    );
  }
}

function validateTauriResourceMapping(path: string): void {
  if (!existsSync(path)) {
    throw new Error(`Tauri config was not found: ${path}`);
  }
  const config = JSON.parse(readFileSync(path, 'utf8')) as {
    bundle?: {
      resources?: unknown;
      targets?: unknown;
    };
  };
  const resources = config.bundle?.resources;
  if (
    !resources ||
    Array.isArray(resources) ||
    typeof resources !== 'object' ||
    (resources as Record<string, unknown>)['generated-resources/*'] !==
      'resources/' ||
    (resources as Record<string, unknown>)['../../../LICENSE'] !==
      'legal/LICENSE' ||
    (resources as Record<string, unknown>)['../../../PRIVACY.md'] !==
      'legal/PRIVACY.md' ||
    (resources as Record<string, unknown>)['../../../CHANGELOG.md'] !==
      'legal/CHANGELOG.md' ||
    (resources as Record<string, unknown>)[
      '../../../THIRD_PARTY_NOTICES.md'
    ] !== 'legal/THIRD_PARTY_NOTICES.md' ||
    !Array.isArray(config.bundle?.targets) ||
    config.bundle.targets.length !== 1 ||
    config.bundle.targets[0] !== 'nsis'
  ) {
    throw new Error(
      'Tauri must map generated runtime resources and legal documents into packaged resource paths.',
    );
  }
}

interface ReleaseMetadata {
  readonly schema_version: number;
  readonly version: string;
  readonly python_runtime_version: string;
  readonly release_tag: string;
  readonly channel: string;
  readonly distribution_profile: string;
  readonly publishable: boolean;
  readonly distribution_mode: string;
  readonly signed: boolean;
  readonly warnings?: {
    readonly smartscreen?: string;
    readonly production_ready?: boolean;
  };
  readonly sha256_verification?: {
    readonly required?: boolean;
    readonly algorithm?: string;
  };
  readonly runtime_assets?: {
    readonly backend?: {
      readonly distribution?: string;
      readonly file_name?: string;
      readonly sha256?: string;
      readonly bytes?: number;
    };
    readonly windowsml_ocr?: {
      readonly distribution?: string;
      readonly file_name?: string;
      readonly sha256?: string;
      readonly bytes?: number;
    };
    readonly capture_runtime?: {
      readonly distribution?: string;
      readonly file_name?: string;
      readonly runtime_version?: string;
      readonly api_version?: string;
      readonly capture_document_schema_version?: string;
      readonly sha256?: string;
      readonly bytes?: number;
      readonly schema_file_name?: string;
      readonly schema_sha256?: string;
      readonly structuring_mode?: string;
      readonly runtime_requirements?: CaptureRuntimeManifest['runtimeRequirements'];
    };
  };
}

function loadReleaseMetadata(path: string): ReleaseMetadata {
  return JSON.parse(readFileSync(path, 'utf8')) as ReleaseMetadata;
}

function validateReleaseMetadata(
  metadata: ReleaseMetadata,
  backend: RuntimeManifest,
  windowsml: RuntimeManifest,
  capture: CaptureRuntimeManifest,
): void {
  if (
    metadata.schema_version !== 1 ||
    backend.version !== ALPHA_VERSION ||
    windowsml.version !== ALPHA_VERSION ||
    metadata.version !== ALPHA_VERSION ||
    metadata.python_runtime_version !== PYTHON_RUNTIME_VERSION ||
    metadata.release_tag !== `cert-prep-v${ALPHA_VERSION}` ||
    metadata.channel !== 'unsigned_public_alpha' ||
    metadata.distribution_profile !== 'public_unsigned_alpha' ||
    metadata.publishable !== true ||
    metadata.distribution_mode !== 'release' ||
    metadata.signed !== false ||
    metadata.warnings?.production_ready !== false ||
    !metadata.warnings.smartscreen ||
    metadata.sha256_verification?.required !== true ||
    metadata.sha256_verification.algorithm !== 'SHA-256'
  ) {
    throw new Error(
      'Release metadata does not declare the unsigned public Alpha contract.',
    );
  }
  if (
    metadata.runtime_assets?.backend?.distribution !== 'bundled' ||
    metadata.runtime_assets?.windowsml_ocr?.distribution !==
      'github_release_download' ||
    metadata.runtime_assets?.capture_runtime?.distribution !==
      'explicit_staged_artifact' ||
    metadata.runtime_assets.capture_runtime.structuring_mode !== 'host'
  ) {
    throw new Error('Release metadata runtime distribution is not public.');
  }
  for (const [name, actual, expected] of [
    ['backend', metadata.runtime_assets?.backend, backend.artifact],
    [
      'windowsml_ocr',
      metadata.runtime_assets?.windowsml_ocr,
      windowsml.artifact,
    ],
  ] as const) {
    if (
      actual?.file_name !== expected.file_name ||
      actual.sha256?.toLowerCase() !== expected.sha256.toLowerCase() ||
      actual.bytes !== expected.bytes
    ) {
      throw new Error(
        `Release metadata ${name} asset does not match its manifest.`,
      );
    }
  }
  const captureMetadata = metadata.runtime_assets?.capture_runtime;
  const captureRequirement = capture.runtimeRequirements['windowsml-ocr'];
  const metadataRequirement = validateCaptureWindowsmlDescriptor(
    captureMetadata?.runtime_requirements?.['windowsml-ocr'],
    'Release metadata Capture runtime WindowsML requirement',
  );
  if (
    captureMetadata?.file_name !== capture.fileName ||
    captureMetadata.runtime_version !== capture.runtimeVersion ||
    captureMetadata.api_version !== capture.apiVersion ||
    captureMetadata.capture_document_schema_version !==
      capture.captureDocumentSchemaVersion ||
    captureMetadata.sha256?.toLowerCase() !== capture.sha256.toLowerCase() ||
    captureMetadata.bytes !== capture.bytes ||
    captureMetadata.schema_file_name !== capture.schemaFileName ||
    captureMetadata.schema_sha256?.toLowerCase() !==
      capture.schemaSha256.toLowerCase() ||
    metadataRequirement.artifactUrl !== captureRequirement.artifactUrl ||
    metadataRequirement.artifactFileName !==
      captureRequirement.artifactFileName ||
    metadataRequirement.bytes !== captureRequirement.bytes ||
    metadataRequirement.sha256 !== captureRequirement.sha256
  ) {
    throw new Error(
      'Release metadata Capture runtime asset does not match its manifest.',
    );
  }
}

function validateLegalResources(
  releaseRoot: string,
  workspaceRoot: string,
): ReturnType<typeof publicFileRecord>[] {
  return [
    'LICENSE',
    'PRIVACY.md',
    'CHANGELOG.md',
    'THIRD_PARTY_NOTICES.md',
  ].map((name) => {
    const path = join(releaseRoot, 'legal', name);
    if (!existsSync(path)) {
      throw new Error(`Packaged legal resource is missing: legal/${name}`);
    }
    return publicFileRecord({
      absolutePath: path,
      path: path.slice(resolve(workspaceRoot).length + 1).replaceAll('\\', '/'),
      bytes: readFileSync(path).byteLength,
      mb: Number((readFileSync(path).byteLength / 1024 / 1024).toFixed(2)),
    });
  });
}

function rejectDevelopmentReferences(
  resourceRoot: string,
  files: readonly string[],
  workspaceRoot: string,
): void {
  const forbiddenText = [
    'file://',
    resolve(workspaceRoot).replaceAll('\\', '/').toLowerCase(),
    resolve(workspaceRoot).replaceAll('/', '\\').toLowerCase(),
    'c:/software-dev/',
    'c:\\software-dev\\',
  ];
  for (const path of files) {
    const content = readFileSync(path).toString('latin1').toLowerCase();
    const match = forbiddenText.find(
      (needle) => needle && content.includes(needle),
    );
    if (match) {
      throw new Error(
        `Packaged runtime resource contains a development path or file URL: ${basename(path)}`,
      );
    }
  }
  if (files.length === 0) {
    throw new Error(
      `No packaged runtime resources found under ${resourceRoot}`,
    );
  }
}
