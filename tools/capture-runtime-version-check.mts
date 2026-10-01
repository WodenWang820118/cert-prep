import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readCaptureVersion } from './capture-version-source.mts';

import {
  CAPTURE_SIDECAR_LAUNCHER_VERSION,
  CAPTURE_RUNTIME_CLIENT_PACKAGE_NAME,
  CAPTURE_RUNTIME_PACKAGE_NAME,
  CAPTURE_RUNTIME_VERSION,
} from './capture-runtime-version.mts';
import {
  CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS,
  captureRuntimeConsumerSnapshot,
  createCaptureRuntimeConsumerDiskSource,
  readCaptureRuntimeConsumerSnapshot,
  type CaptureRuntimeConsumerSnapshot,
  type CaptureRuntimeConsumerSource,
  verifyCaptureRuntimeConsumerSnapshot,
} from './capture-runtime-consumer-source.mts';

function read(workspaceRoot: string, relativePath: string): string {
  return readFileSync(join(workspaceRoot, relativePath), 'utf8');
}

function readSource(
  source: CaptureRuntimeConsumerSource,
  relativePath: (typeof CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS)[number],
): string {
  const file = source.readFile(relativePath);
  if (file.kind !== 'file' || file.bytes === undefined) {
    throw new Error(
      `Capture Runtime consumer source ${relativePath} is ${file.kind}; expected a regular file.`,
    );
  }
  return new TextDecoder().decode(file.bytes);
}

function requireMatch(
  workspaceRoot: string,
  relativePath: string,
  pattern: RegExp,
): void {
  const content = read(workspaceRoot, relativePath);
  if (!pattern.test(content)) {
    throw new Error(
      `${relativePath} does not declare the Capture Runtime ${CAPTURE_RUNTIME_VERSION} contract.`,
    );
  }
}

function requireNotExists(workspaceRoot: string, relativePath: string): void {
  if (existsSync(join(workspaceRoot, relativePath))) {
    throw new Error(
      `${relativePath} must not exist after the generated contract cutover.`,
    );
  }
}

export const CAPTURE_RUNTIME_CONSUMER_INVENTORY_FIELDS = [
  { key: 'cert.package.workbenchUi', kind: 'runtimeVersion' },
  { key: 'cert.workspace.workbenchUi', kind: 'runtimeVersion' },
  { key: 'cert.workspace.runtimeClient', kind: 'runtimeVersion' },
  { key: 'cert.lock.workbenchUi', kind: 'runtimeVersion' },
  { key: 'cert.lock.runtimeClient', kind: 'runtimeVersion' },
  { key: 'cert.version.runtime', kind: 'runtimeVersion' },
  { key: 'cert.version.sidecar', kind: 'runtimeVersion' },
  { key: 'cert.backend.pythonClient', kind: 'runtimeVersion' },
  { key: 'cert.backend.uvLock', kind: 'runtimeVersion' },
  { key: 'cert.backend.runtimePolicy', kind: 'structural' },
  { key: 'cert.backend.mapping', kind: 'structural' },
  { key: 'cert.backend.client', kind: 'structural' },
  { key: 'cert.backend.runtimeProvenance', kind: 'runtimeProvenanceIdentity' },
  { key: 'cert.desktop.constants.runtime', kind: 'runtimeVersion' },
  { key: 'cert.desktop.constants.api', kind: 'apiVersion' },
  {
    key: 'cert.desktop.constants.documentSchema',
    kind: 'documentSchemaVersion',
  },
  { key: 'cert.desktop.cargoToml', kind: 'runtimeVersion' },
  { key: 'cert.desktop.cargoLock', kind: 'runtimeVersion' },
  { key: 'cert.desktop.projectRuntime', kind: 'structural' },
  { key: 'cert.desktop.captureManifest', kind: 'structural' },
  { key: 'cert.desktop.manifests', kind: 'structural' },
  { key: 'cert.desktop.backendLaunchEnv', kind: 'structural' },
  { key: 'cert.desktop.captureRuntimeConnection', kind: 'structural' },
  { key: 'cert.desktop.packageQa', kind: 'structural' },
  { key: 'cert.installScript', kind: 'structural' },
  { key: 'cert.consumerSmoke', kind: 'structural' },
  { key: 'cert.frontendCompatibility', kind: 'structural' },
  { key: 'cert.generated.runtimeReady', kind: 'runtimeReadyIdentity' },
  { key: 'cert.generated.ocrPreflight', kind: 'preflightIdentity' },
] as const;

export const CAPTURE_RUNTIME_CONTRACT_SET_VERSION = '2';
export const CAPTURE_RUNTIME_API_VERSION_FLOOR = '2.0';
export const CAPTURE_DOCUMENT_SCHEMA_VERSION_FLOOR = '2';
export const CAPTURE_OCR_PROJECTION_SCHEMA_VERSION = '3';

export type CaptureRuntimeConsumerInventoryKey =
  (typeof CAPTURE_RUNTIME_CONSUMER_INVENTORY_FIELDS)[number]['key'];

export type CaptureRuntimeConsumerInventoryEntry = {
  readonly key: CaptureRuntimeConsumerInventoryKey;
  readonly source: string;
  readonly value: string | undefined;
};

/**
 * Read-only producer identity input. The projection schema is derived from
 * the contract bytes; callers cannot supply a separate schema accessor.
 */
export type CaptureRuntimeContractSource = {
  readonly source: string;
  readonly bytes: Uint8Array;
  readonly declaredSha256: string;
};

export type CaptureRuntimeConsumerInventoryReport = {
  readonly status: 'ready' | 'blocked';
  readonly expectedRuntimeVersion: string | undefined;
  readonly expectedApiVersion: string;
  readonly expectedDocumentSchemaVersion: string;
  readonly expectedContractSetVersion: string;
  readonly observedRuntimeVersion: string | undefined;
  readonly contractSource: string;
  readonly contractSetSha256: string | undefined;
  readonly contractSchemaNames: readonly string[];
  readonly ocrProjectionSchemaVersion: string | undefined;
  readonly entries: readonly CaptureRuntimeConsumerInventoryEntry[];
  readonly errors: readonly string[];
};

export type CaptureRuntimeConsumerInventoryInput = {
  readonly entries: readonly CaptureRuntimeConsumerInventoryEntry[];
  readonly contract: CaptureRuntimeContractSource;
  readonly sourceErrors?: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SEMVER = '(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)';

function captureRuntimeVersionsFromLock(
  content: string,
  packageName: string,
  sourceErrors: string[],
): string[] {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const lines = content.split(/\r?\n/u);
  type LockSection = 'packages' | 'snapshots';
  type LockDocument = Record<LockSection, string[][]>;
  const documents: LockDocument[] = [];
  let document: LockDocument = { packages: [], snapshots: [] };
  let activeSection: { name: LockSection; lines: string[] } | undefined;
  const finishDocument = (): void => {
    if (document.packages.length > 0 || document.snapshots.length > 0) {
      documents.push(document);
    }
    document = { packages: [], snapshots: [] };
    activeSection = undefined;
  };

  for (const line of lines) {
    if (line === '---') {
      finishDocument();
      continue;
    }
    if (/^\S[^:]*:(?:\s.*)?$/u.test(line)) {
      const sectionName = line.match(/^(packages|snapshots):$/u)?.[1] as
        | LockSection
        | undefined;
      if (sectionName) {
        const sectionLines: string[] = [];
        document[sectionName].push(sectionLines);
        activeSection = { name: sectionName, lines: sectionLines };
      } else {
        activeSection = undefined;
      }
      continue;
    }
    if (activeSection) activeSection.lines.push(line);
  }
  finishDocument();

  const targetMatches = (sectionLines: string[]): string[] =>
    [
      ...sectionLines
        .join('\n')
        .matchAll(
          new RegExp(
            `^\\s{2}['"]?${escapedName}@${SEMVER}(?:\\([^\\n]*\\))?['"]?:`,
            'gmu',
          ),
        ),
    ].map((match) => match[1]);
  const matchesByDocument = documents.map((lockDocument) => ({
    packages: lockDocument.packages.flatMap(targetMatches),
    snapshots: lockDocument.snapshots.flatMap(targetMatches),
  }));
  // pnpm 12 may prepend a separate config-dependency document; only the
  // document that owns this package may supply the consumer declaration.
  const owningDocuments = matchesByDocument.flatMap((matches, index) =>
    matches.packages.length > 0 || matches.snapshots.length > 0 ? [index] : [],
  );
  if (owningDocuments.length > 1) {
    sourceErrors.push(
      `pnpm-lock.yaml:${packageName} must have exactly one owning lock document; found ${owningDocuments.length}.`,
    );
  }
  const ownerIndex = owningDocuments[0];
  const owner = ownerIndex === undefined ? undefined : documents[ownerIndex];

  const versions: string[] = [];
  for (const sectionName of ['packages', 'snapshots'] as const) {
    const sectionBlocks = owner?.[sectionName] ?? [];
    if (sectionBlocks.length !== 1) {
      sourceErrors.push(
        `pnpm-lock.yaml:${packageName} must have exactly one ${sectionName} section in the owning lock document; found ${sectionBlocks.length}.`,
      );
      continue;
    }
    const matches = targetMatches(sectionBlocks[0]);
    if (matches.length !== 1) {
      sourceErrors.push(
        `pnpm-lock.yaml:${packageName} must have exactly one declaration in the ${sectionName} section; found ${matches.length}.`,
      );
      continue;
    }
    versions.push(matches[0]);
  }
  if (versions.length !== 2 || versions[0] !== versions[1]) {
    sourceErrors.push(
      `pnpm-lock.yaml:${packageName} packages and snapshots declarations must agree on one version; found ${versions.join(', ')}.`,
    );
    return [];
  }
  return [versions[0]];
}

function packageBlockVersion(
  content: string,
  packageName: string,
  sourceErrors: string[],
  sourceLabel: string,
): string | undefined {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const blocks = [
    ...content.matchAll(
      new RegExp(
        `\\[\\[package\\]\\]\\r?\\nname = "${escapedName}"[\\s\\S]*?(?=\\r?\\n\\[\\[package\\]\\]|$)`,
        'gu',
      ),
    ),
  ].map((match) => match[0]);
  if (blocks.length !== 1) {
    sourceErrors.push(
      `${sourceLabel} must contain exactly one ${packageName} package block; found ${blocks.length}.`,
    );
    return undefined;
  }
  const versions = [...blocks[0].matchAll(/^version = "([^"]+)"$/gmu)].map(
    (match) => match[1],
  );
  if (versions.length !== 1) {
    sourceErrors.push(
      `${sourceLabel} must contain exactly one ${packageName} version; found ${versions.length}.`,
    );
    return undefined;
  }
  return versions[0];
}

function uniqueVersion(
  values: readonly string[],
  sourceLabel: string,
  sourceErrors: string[],
  allowRepeatedSameValue = false,
): string | undefined {
  const unique = [...new Set(values)];
  if (unique.length === 1 && (allowRepeatedSameValue || values.length === 1)) {
    return unique[0];
  }
  if (values.length > 0) {
    sourceErrors.push(
      `${sourceLabel} has ambiguous versions: ${unique.join(', ')} (${values.length} declarations).`,
    );
  }
  return undefined;
}

function uniqueIdentity(
  values: readonly string[],
  sourceLabel: string,
  sourceErrors: string[],
): string | undefined {
  if (values.length === 1) return values[0];
  sourceErrors.push(
    `${sourceLabel} must declare exactly one identity; found ${values.length}.`,
  );
  return undefined;
}

function identityTuple(
  values: {
    readonly runtimeVersion: string | undefined;
    readonly apiVersion: string | undefined;
    readonly documentSchemaVersion?: string | undefined;
    readonly contractSetVersion: string | undefined;
  },
  allowMissingRuntime = false,
): string | undefined {
  const fields = [
    ...(values.runtimeVersion === undefined
      ? []
      : [['runtime', values.runtimeVersion] as const]),
    ['api', values.apiVersion],
    ...(values.documentSchemaVersion === undefined
      ? []
      : [['document', values.documentSchemaVersion] as const]),
    ['contractSet', values.contractSetVersion],
  ] as const;
  return (allowMissingRuntime || values.runtimeVersion !== undefined) &&
    fields.every(([, value]) => value !== undefined)
    ? fields.map(([name, value]) => `${name}=${value}`).join(';')
    : undefined;
}

function field(
  key: CaptureRuntimeConsumerInventoryKey,
  source: string,
  value: string | undefined,
): CaptureRuntimeConsumerInventoryEntry {
  return { key, source, value };
}

function present(
  sourceReader: CaptureRuntimeConsumerSource,
  relativePath: string,
  expression: RegExp,
  key: CaptureRuntimeConsumerInventoryKey,
  source: string,
): CaptureRuntimeConsumerInventoryEntry {
  const flags = expression.flags.includes('g')
    ? expression.flags
    : `${expression.flags}g`;
  const matches = [
    ...readSource(
      sourceReader,
      relativePath as (typeof CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS)[number],
    ).matchAll(new RegExp(expression.source, flags)),
  ];
  return field(
    key,
    `${relativePath}:${source}`,
    matches.length > 0 ? 'structural' : undefined,
  );
}

function captureSingle(
  content: string,
  pattern: RegExp,
  sourceLabel: string,
  sourceErrors: string[],
): string | undefined {
  const flags = pattern.flags.includes('g')
    ? pattern.flags
    : `${pattern.flags}g`;
  const matches = [...content.matchAll(new RegExp(pattern.source, flags))].map(
    (match) => match[1],
  );
  return uniqueIdentity(matches, sourceLabel, sourceErrors);
}

function generatedIdentity(
  content: string,
  schemaName: string,
  sourceLabel: string,
  sourceErrors: string[],
  fields: readonly string[],
): string | undefined {
  const schemaBlocks = [
    ...content.matchAll(
      new RegExp(`\\b${schemaName}:\\s*\\{([\\s\\S]*?)\\};`, 'gu'),
    ),
  ].map((match) => match[1]);
  if (schemaBlocks.length !== 1) {
    sourceErrors.push(
      `${sourceLabel} must declare exactly one ${schemaName} type; found ${schemaBlocks.length}.`,
    );
    return undefined;
  }
  const values = new Map<string, string | undefined>();
  for (const name of fields) {
    const pattern = new RegExp(`"${name}"\\??:\\s*"([^"]+)"`, 'u');
    const matches = [
      ...schemaBlocks[0].matchAll(new RegExp(pattern.source, 'gu')),
    ].map((match) => match[1]);
    if (name === 'runtimeVersion' && matches.length === 0) {
      values.set(name, undefined);
      continue;
    }
    values.set(
      name,
      uniqueIdentity(
        matches,
        `${sourceLabel}:${schemaName}.${name}`,
        sourceErrors,
      ),
    );
  }
  return identityTuple(
    {
      runtimeVersion: values.get('runtimeVersion'),
      apiVersion: values.get('apiVersion'),
      documentSchemaVersion: values.get('captureDocumentSchemaVersion'),
      contractSetVersion: values.get('contractSetVersion'),
    },
    true,
  );
}

function runtimeProvenanceIdentity(
  content: string,
  sourceLabel: string,
  sourceErrors: string[],
  adoptedVersion: string | undefined,
): string | undefined {
  if (/from capture_runtime_client import CAPTURE_RUNTIME_VERSION/u.test(content) &&
      /value\.get\("runtime_version"\) != CAPTURE_RUNTIME_VERSION/u.test(content) &&
      /wheel\.get\(\s*"package_version"\s*\)\s*!=\s*CAPTURE_RUNTIME_VERSION/u.test(content)) {
    return adoptedVersion ? `runtime=${adoptedVersion};wheel=${adoptedVersion}` : undefined;
  }
  const runtime = captureSingle(
    content,
    /value\.get\("runtime_version"\) != "([^"]+)"/u,
    `${sourceLabel}:runtime_version`,
    sourceErrors,
  );
  const wheel = captureSingle(
    content,
    /wheel\.get\(\s*"package_version"\s*\)\s*!=\s*"([^"]+)"/u,
    `${sourceLabel}:python_wheel.package_version`,
    sourceErrors,
  );
  return runtime !== undefined && wheel !== undefined
    ? `runtime=${runtime};wheel=${wheel}`
    : undefined;
}

export function readCaptureRuntimeConsumerInventory(
  workspaceRoot: string,
  contract: CaptureRuntimeContractSource,
): CaptureRuntimeConsumerInventoryInput {
  return readCaptureRuntimeConsumerInventoryFromSource(
    createCaptureRuntimeConsumerDiskSource(workspaceRoot),
    contract,
  );
}

export function captureRuntimeConsumerSnapshotFromWorkspace(
  workspaceRoot: string,
  sourceHead: string,
): CaptureRuntimeConsumerSnapshot {
  return captureRuntimeConsumerSnapshot(
    createCaptureRuntimeConsumerDiskSource(workspaceRoot),
    sourceHead,
  );
}

export function readCaptureRuntimeConsumerInventoryFromSnapshot(
  snapshot: CaptureRuntimeConsumerSnapshot,
  contract: CaptureRuntimeContractSource,
): CaptureRuntimeConsumerInventoryInput {
  return readCaptureRuntimeConsumerInventoryFromSource(
    readCaptureRuntimeConsumerSnapshot(snapshot),
    contract,
  );
}

export function verifyCaptureRuntimeConsumerSnapshotAgainstWorkspace(
  snapshot: CaptureRuntimeConsumerSnapshot,
  workspaceRoot: string,
  currentSourceHead: string,
): void {
  verifyCaptureRuntimeConsumerSnapshot(
    snapshot,
    createCaptureRuntimeConsumerDiskSource(workspaceRoot),
    currentSourceHead,
  );
}

function readCaptureRuntimeConsumerInventoryFromSource(
  sourceReader: CaptureRuntimeConsumerSource,
  contract: CaptureRuntimeContractSource,
): CaptureRuntimeConsumerInventoryInput {
  const sourceErrors: string[] = [];
  const packageManifestContent = readSource(sourceReader, 'package.json');
  JSON.parse(packageManifestContent) as {
    dependencies?: Record<string, unknown>;
  };
  const workspace = readSource(sourceReader, 'pnpm-workspace.yaml');
  const pnpmLock = readSource(sourceReader, 'pnpm-lock.yaml');
  const versionSource = readSource(
    sourceReader,
    'tools/capture-runtime-version.mts',
  );
  let adoptedVersion: string | undefined;
  try {
    adoptedVersion = readCaptureVersion(readSource(sourceReader, 'tools/capture-runtime-version.json'));
  } catch (error) {
    sourceErrors.push(String(error));
  }
  if (!versionSource.includes("new URL('./capture-runtime-version.json', import.meta.url)") ||
      !versionSource.includes('CAPTURE_SIDECAR_LAUNCHER_VERSION = CAPTURE_RUNTIME_VERSION;')) {
    sourceErrors.push('Capture TypeScript facade must read the shared adoption source.');
  }
  const rustBuild = readSource(sourceReader, 'apps/cert-prep-desktop/src-tauri/build.rs');
  const rustConstants = readSource(sourceReader, 'apps/cert-prep-desktop/src-tauri/src/constants.rs');
  const rustShared = rustBuild.includes('../../../tools/capture-runtime-version.json') &&
    /pin\["runtimeVersion"\]\s*\.as_str\(\)/u.test(rustBuild) &&
    rustBuild.includes('cargo:rustc-env=CERT_PREP_CAPTURE_RUNTIME_VERSION={version}') &&
    rustConstants.includes('CAPTURE_RUNTIME_VERSION: &str = env!("CERT_PREP_CAPTURE_RUNTIME_VERSION")');
  const backendPolicy =
    'apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/runtime_policy.py';
  const backendMapping =
    'apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/mapping.py';
  const backendClient =
    'apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/client.py';
  const runtimeProvenance =
    'apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/runtime_provenance.py';
  const desktopConstants = 'apps/cert-prep-desktop/src-tauri/src/constants.rs';
  const desktopCargo = 'apps/cert-prep-desktop/src-tauri/Cargo.toml';
  const desktopCargoLock = 'apps/cert-prep-desktop/src-tauri/Cargo.lock';
  const desktopManifest =
    'apps/cert-prep-desktop/src-tauri/src/capture_manifest.rs';
  const desktopManifests = 'apps/cert-prep-desktop/src-tauri/src/manifests.rs';
  const desktopLaunch =
    'apps/cert-prep-desktop/src-tauri/src/backend_process.rs';
  const desktopConnection =
    'apps/cert-prep-desktop/src-tauri/src/capture_runtime.rs';
  const desktopProject = 'apps/cert-prep-desktop/project.json';
  const packageQa = 'apps/cert-prep-desktop/scripts/package-qa/constants.mts';
  const installScript = 'tools/install-capture-runtime.mts';
  const consumerSmoke = 'tools/capture-runtime-consumer-smoke.mts';
  const frontendCompatibility =
    'apps/cert-prep/src/app/pages/capture-workbench-trial/cert-prep-capture-client.ts';
  const generated = 'libs/cert-prep-api/src/lib/cert-prep-api.generated.ts';

  const cargoLockContent = readSource(
    sourceReader,
    desktopCargoLock as (typeof CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS)[number],
  );
  const packageUi = CAPTURE_RUNTIME_PACKAGE_NAME;
  const packageClient = CAPTURE_RUNTIME_CLIENT_PACKAGE_NAME;
  const workspaceValue = (packageName: string): string | undefined =>
    uniqueVersion(
      [
        ...workspace.matchAll(
          new RegExp(
            `${packageName.replace('/', '\\/')}@(${SEMVER.slice(1, -1)})`,
            'gu',
          ),
        ),
      ].map((match) => match[1]),
      `pnpm-workspace.yaml:${packageName}`,
      sourceErrors,
    );

  const packageUiLockVersion = uniqueVersion(
    captureRuntimeVersionsFromLock(pnpmLock, packageUi, sourceErrors),
    `pnpm-lock.yaml:${packageUi}`,
    sourceErrors,
  );
  const packageClientLockVersion = uniqueVersion(
    captureRuntimeVersionsFromLock(pnpmLock, packageClient, sourceErrors),
    `pnpm-lock.yaml:${packageClient}`,
    sourceErrors,
  );
  const runtimeProvenanceContent = readSource(
    sourceReader,
    runtimeProvenance as (typeof CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS)[number],
  );
  const desktopLaunchContent = readSource(
    sourceReader,
    desktopLaunch as (typeof CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS)[number],
  );
  const generatedContent = readSource(
    sourceReader,
    generated as (typeof CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS)[number],
  );

  return {
    contract,
    sourceErrors,
    entries: [
      field(
        'cert.package.workbenchUi',
        'package.json:dependencies.@gx-capture/capture-workbench-ui',
        captureSingle(
          packageManifestContent,
          /"@gx-capture\/capture-workbench-ui"\s*:\s*"([^"]+)"/u,
          'package.json:dependencies.@gx-capture/capture-workbench-ui',
          sourceErrors,
        ),
      ),
      field(
        'cert.workspace.workbenchUi',
        'pnpm-workspace.yaml:@gx-capture/capture-workbench-ui',
        workspaceValue(packageUi),
      ),
      field(
        'cert.workspace.runtimeClient',
        'pnpm-workspace.yaml:@gx-capture/capture-runtime-client',
        workspaceValue(packageClient),
      ),
      field(
        'cert.lock.workbenchUi',
        'pnpm-lock.yaml:@gx-capture/capture-workbench-ui',
        packageUiLockVersion,
      ),
      field(
        'cert.lock.runtimeClient',
        'pnpm-lock.yaml:@gx-capture/capture-runtime-client',
        packageClientLockVersion,
      ),
      field(
        'cert.version.runtime',
        'tools/capture-runtime-version.mts:CAPTURE_RUNTIME_VERSION',
        adoptedVersion,
      ),
      field(
        'cert.version.sidecar',
        'tools/capture-runtime-version.mts:CAPTURE_SIDECAR_LAUNCHER_VERSION',
        adoptedVersion,
      ),
      field(
        'cert.backend.pythonClient',
        'apps/cert-prep-backend/pyproject.toml:capture-runtime-client',
        captureSingle(
          readSource(sourceReader, 'apps/cert-prep-backend/pyproject.toml'),
          /capture-runtime-client==([^\s,"']+)/u,
          'apps/cert-prep-backend/pyproject.toml:capture-runtime-client',
          sourceErrors,
        ),
      ),
      field(
        'cert.backend.uvLock',
        'apps/cert-prep-backend/uv.lock:capture-runtime-client',
        packageBlockVersion(
          readSource(sourceReader, 'apps/cert-prep-backend/uv.lock'),
          'capture-runtime-client',
          sourceErrors,
          'apps/cert-prep-backend/uv.lock',
        ),
      ),
      present(
        sourceReader,
        backendPolicy,
        /SUPPORTED_RUNTIME_VERSION = CAPTURE_RUNTIME_VERSION/u,
        'cert.backend.runtimePolicy',
        'SUPPORTED_RUNTIME_VERSION',
      ),
      present(
        sourceReader,
        backendMapping,
        /from capture_runtime_client import/u,
        'cert.backend.mapping',
        'capture_runtime_client import',
      ),
      present(
        sourceReader,
        backendClient,
        /SdkCaptureRuntimeClient/u,
        'cert.backend.client',
        'SdkCaptureRuntimeClient',
      ),
      field(
        'cert.backend.runtimeProvenance',
        'capture_runtime_attestation/_validate_candidate',
        runtimeProvenanceIdentity(
          runtimeProvenanceContent,
          `${runtimeProvenance}:_validate_candidate`,
          sourceErrors,
          adoptedVersion,
        ),
      ),
      field(
        'cert.desktop.constants.runtime',
        `${desktopConstants}:CAPTURE_RUNTIME_VERSION`,
        rustShared ? adoptedVersion : captureSingle(
          readSource(
            sourceReader,
            desktopConstants as (typeof CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS)[number],
          ),
          /CAPTURE_RUNTIME_VERSION: &str = "([^"]+)"/u,
          `${desktopConstants}:CAPTURE_RUNTIME_VERSION`,
          sourceErrors,
        ),
      ),
      field(
        'cert.desktop.constants.api',
        `${desktopConstants}:CAPTURE_RUNTIME_API_VERSION`,
        captureSingle(
          readSource(
            sourceReader,
            desktopConstants as (typeof CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS)[number],
          ),
          /CAPTURE_RUNTIME_API_VERSION: &str = "([^"]+)"/u,
          `${desktopConstants}:CAPTURE_RUNTIME_API_VERSION`,
          sourceErrors,
        ),
      ),
      field(
        'cert.desktop.constants.documentSchema',
        `${desktopConstants}:CAPTURE_DOCUMENT_SCHEMA_VERSION`,
        captureSingle(
          readSource(
            sourceReader,
            desktopConstants as (typeof CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS)[number],
          ),
          /CAPTURE_DOCUMENT_SCHEMA_VERSION: &str = "([^"]+)"/u,
          `${desktopConstants}:CAPTURE_DOCUMENT_SCHEMA_VERSION`,
          sourceErrors,
        ),
      ),
      field(
        'cert.desktop.cargoToml',
        `${desktopCargo}:capture-sidecar-launcher`,
        captureSingle(
          readSource(
            sourceReader,
            desktopCargo as (typeof CAPTURE_RUNTIME_CONSUMER_SOURCE_PATHS)[number],
          ),
          /capture-sidecar-launcher\s*=\s*"=([^"]+)"/u,
          `${desktopCargo}:capture-sidecar-launcher`,
          sourceErrors,
        ),
      ),
      field(
        'cert.desktop.cargoLock',
        `${desktopCargoLock}:capture-sidecar-launcher`,
        packageBlockVersion(
          cargoLockContent,
          'capture-sidecar-launcher',
          sourceErrors,
          desktopCargoLock,
        ),
      ),
      present(
        sourceReader,
        desktopProject,
        /"outputs": \["\{workspaceRoot\}\/tmp\/cert-prep\/capture-runtime"\]/u,
        'cert.desktop.projectRuntime',
        'install-capture-runtime outputs',
      ),
      present(
        sourceReader,
        desktopManifest,
        /capture_manifest_expectations[\s\S]*capture_runtime_expected_version/u,
        'cert.desktop.captureManifest',
        'capture_manifest_expectations/capture_runtime_expected_version',
      ),
      present(
        sourceReader,
        desktopManifests,
        /RuntimeManifest[\s\S]*verify_artifact/u,
        'cert.desktop.manifests',
        'RuntimeManifest/verify_artifact',
      ),
      field(
        'cert.desktop.backendLaunchEnv',
        'backend_launch_env runtime identity',
        /backend_launch_env[\s\S]*CERT_PREP_CAPTURE_RUNTIME_VERSION[\s\S]*capture_runtime\.runtime_version\.clone\(\)[\s\S]*CERT_PREP_CAPTURE_RUNTIME_API_VERSION[\s\S]*capture_runtime\.api_version\.clone\(\)[\s\S]*CERT_PREP_CAPTURE_DOCUMENT_SCHEMA_VERSION[\s\S]*capture_runtime\.capture_document_schema_version\.clone\(\)/u.test(
          desktopLaunchContent,
        )
          ? 'structural'
          : undefined,
      ),
      present(
        sourceReader,
        desktopConnection,
        /CaptureRuntimeConnection/u,
        'cert.desktop.captureRuntimeConnection',
        'CaptureRuntimeConnection',
      ),
      present(
        sourceReader,
        packageQa,
        /from ['"]\.\.\/\.\.\/\.\.\/\.\.\/tools\/capture-runtime-version\.mts['"]/u,
        'cert.desktop.packageQa',
        'capture-runtime-version import',
      ),
      present(
        sourceReader,
        installScript,
        /from ['"]\.\/capture-runtime-version\.mts['"]/u,
        'cert.installScript',
        'capture-runtime-version import',
      ),
      present(
        sourceReader,
        consumerSmoke,
        /CAPTURE_RUNTIME_RELEASE_BASE_URL/u,
        'cert.consumerSmoke',
        'CAPTURE_RUNTIME_RELEASE_BASE_URL',
      ),
      present(
        sourceReader,
        frontendCompatibility,
        /assertCaptureRuntimeCompatible\(ready, CAPTURE_RUNTIME_MAJOR, 'host'\)/u,
        'cert.frontendCompatibility',
        'assertCaptureRuntimeCompatible',
      ),
      field(
        'cert.generated.runtimeReady',
        `${generated}:RuntimeReady`,
        generatedIdentity(
          generatedContent,
          'RuntimeReady',
          generated,
          sourceErrors,
          [
            'runtimeVersion',
            'apiVersion',
            'captureDocumentSchemaVersion',
            'contractSetVersion',
          ],
        ),
      ),
      field(
        'cert.generated.ocrPreflight',
        `${generated}:OcrComputePreflightV2`,
        generatedIdentity(
          generatedContent,
          'OcrComputePreflightV2',
          generated,
          sourceErrors,
          ['runtimeVersion', 'apiVersion', 'contractSetVersion'],
        ),
      ),
    ],
  };
}

type ParsedContractIdentity = {
  readonly schemaNames: readonly string[];
  readonly duplicateSchemaNames: readonly string[];
  readonly contractSetVersion: string | undefined;
  readonly runtimeVersion: string | undefined;
  readonly apiVersion: string | undefined;
  readonly documentSchemaVersion: string | undefined;
  readonly runtimeReadyContractSetVersion: string | undefined;
  readonly preflightSchemaVersion: string | undefined;
  readonly preflightRuntimeVersion: string | undefined;
  readonly preflightApiVersion: string | undefined;
  readonly preflightContractSetVersion: string | undefined;
  readonly ocrProjectionSchemaVersion: string | undefined;
  readonly projectionRuntimeVersion: string | undefined;
  readonly projectionApiVersion: string | undefined;
};

function schemaConst(
  schema: Record<string, unknown> | undefined,
  property: string,
): string | undefined {
  if (!schema || !isRecord(schema.schema)) return undefined;
  const properties = schema.schema.properties;
  if (!isRecord(properties) || !isRecord(properties[property]))
    return undefined;
  const value = properties[property].const;
  return typeof value === 'string' ? value : undefined;
}

function parseContractIdentity(bytes: Uint8Array): ParsedContractIdentity {
  const raw = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (!isRecord(raw) || !Array.isArray(raw.schemas)) {
    return {
      schemaNames: [],
      duplicateSchemaNames: [],
      contractSetVersion: undefined,
      runtimeVersion: undefined,
      apiVersion: undefined,
      documentSchemaVersion: undefined,
      runtimeReadyContractSetVersion: undefined,
      preflightSchemaVersion: undefined,
      preflightRuntimeVersion: undefined,
      preflightApiVersion: undefined,
      preflightContractSetVersion: undefined,
      ocrProjectionSchemaVersion: undefined,
      projectionRuntimeVersion: undefined,
      projectionApiVersion: undefined,
    };
  }
  const schemas = raw.schemas.filter(isRecord);
  const schemaNames = schemas.flatMap((schema) =>
    typeof schema.name === 'string' ? [schema.name] : [],
  );
  const duplicateSchemaNames = [
    ...new Set(
      schemaNames.filter((name, index) => schemaNames.indexOf(name) !== index),
    ),
  ];
  const schemaByName = (name: string): Record<string, unknown> | undefined => {
    const matches = schemas.filter((schema) => schema.name === name);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const runtimeReady = schemaByName('RuntimeReady');
  const preflight = schemaByName('OcrComputePreflightV2');
  const projection = schemaByName('CaptureOcrProjectionV3');
  return {
    schemaNames,
    duplicateSchemaNames,
    contractSetVersion:
      typeof raw.contractSetVersion === 'string'
        ? raw.contractSetVersion
        : undefined,
    runtimeVersion: schemaConst(runtimeReady, 'runtimeVersion'),
    apiVersion: schemaConst(runtimeReady, 'apiVersion'),
    documentSchemaVersion: schemaConst(
      runtimeReady,
      'captureDocumentSchemaVersion',
    ),
    runtimeReadyContractSetVersion: schemaConst(
      runtimeReady,
      'contractSetVersion',
    ),
    preflightSchemaVersion: schemaConst(preflight, 'schemaVersion'),
    preflightRuntimeVersion: schemaConst(preflight, 'runtimeVersion'),
    preflightApiVersion: schemaConst(preflight, 'apiVersion'),
    preflightContractSetVersion: schemaConst(preflight, 'contractSetVersion'),
    ocrProjectionSchemaVersion: schemaConst(projection, 'schemaVersion'),
    projectionRuntimeVersion: schemaConst(projection, 'runtimeVersion'),
    projectionApiVersion: schemaConst(projection, 'apiVersion'),
  };
}

export function inspectCaptureRuntimeConsumerInventory(
  input: CaptureRuntimeConsumerInventoryInput,
): CaptureRuntimeConsumerInventoryReport {
  const errors: string[] = [...(input.sourceErrors ?? [])];
  const { contract, entries } = input;
  let parsedContract: ParsedContractIdentity = {
    schemaNames: [],
    duplicateSchemaNames: [],
    contractSetVersion: undefined,
    runtimeVersion: undefined,
    apiVersion: undefined,
    documentSchemaVersion: undefined,
    runtimeReadyContractSetVersion: undefined,
    preflightSchemaVersion: undefined,
    preflightRuntimeVersion: undefined,
    preflightApiVersion: undefined,
    preflightContractSetVersion: undefined,
    ocrProjectionSchemaVersion: undefined,
    projectionRuntimeVersion: undefined,
    projectionApiVersion: undefined,
  };

  let contractSetSha256: string | undefined;
  try {
    contractSetSha256 = createHash('sha256')
      .update(contract.bytes)
      .digest('hex');
    if (!/^[0-9a-f]{64}$/u.test(contract.declaredSha256)) {
      errors.push(
        'producer contract-set SHA-256 declaration is missing or malformed.',
      );
    } else if (contractSetSha256 !== contract.declaredSha256) {
      errors.push(
        `producer contract-set bytes do not match the declared contract-set SHA-256: expected ${contract.declaredSha256}, found ${contractSetSha256}.`,
      );
    }
  } catch (error) {
    errors.push(
      `producer contract-set bytes cannot be hashed: ${String(error)}.`,
    );
  }

  try {
    parsedContract = parseContractIdentity(contract.bytes);
  } catch (error) {
    errors.push(
      `producer contract-set JSON cannot be parsed: ${String(error)}.`,
    );
  }
  for (const duplicateSchemaName of parsedContract.duplicateSchemaNames) {
    errors.push(
      `producer contract-set declares duplicate ${duplicateSchemaName} schemas.`,
    );
  }
  for (const requiredSchema of [
    'RuntimeReady',
    'OcrComputePreflightV2',
    'CaptureOcrProjectionV3',
  ]) {
    if (!parsedContract.schemaNames.includes(requiredSchema)) {
      errors.push(`producer contract-set is missing ${requiredSchema}.`);
    }
  }
  const contractIdentityChecks: ReadonlyArray<
    readonly [string, string | undefined, string]
  > = [
    [
      'contract-set version',
      parsedContract.contractSetVersion,
      CAPTURE_RUNTIME_CONTRACT_SET_VERSION,
    ],
    [
      'API version',
      parsedContract.apiVersion,
      CAPTURE_RUNTIME_API_VERSION_FLOOR,
    ],
    [
      'document schema version',
      parsedContract.documentSchemaVersion,
      CAPTURE_DOCUMENT_SCHEMA_VERSION_FLOOR,
    ],
    [
      'runtime-ready contract-set version',
      parsedContract.runtimeReadyContractSetVersion,
      CAPTURE_RUNTIME_CONTRACT_SET_VERSION,
    ],
    [
      'OCR projection schema version',
      parsedContract.ocrProjectionSchemaVersion,
      CAPTURE_OCR_PROJECTION_SCHEMA_VERSION,
    ],
    ['preflight schema version', parsedContract.preflightSchemaVersion, '1'],
    [
      'preflight API version',
      parsedContract.preflightApiVersion,
      CAPTURE_RUNTIME_API_VERSION_FLOOR,
    ],
    [
      'preflight contract-set version',
      parsedContract.preflightContractSetVersion,
      CAPTURE_RUNTIME_CONTRACT_SET_VERSION,
    ],
    [
      'projection API version',
      parsedContract.projectionApiVersion,
      CAPTURE_RUNTIME_API_VERSION_FLOOR,
    ],
  ];
  for (const [label, actual, expected] of contractIdentityChecks) {
    if (actual === undefined) {
      errors.push(`producer contract-set is missing its ${label} identity.`);
    } else if (actual !== expected) {
      errors.push(
        `producer contract-set ${label} is incompatible: expected ${expected}, found ${actual}.`,
      );
    }
  }
  const runtimeIdentityChecks: ReadonlyArray<
    readonly [string, string | undefined, string | undefined]
  > = [
    [
      'preflight runtime version',
      parsedContract.preflightRuntimeVersion,
      parsedContract.runtimeVersion,
    ],
    [
      'projection runtime version',
      parsedContract.projectionRuntimeVersion,
      parsedContract.runtimeVersion,
    ],
  ];
  for (const [label, actual, expected] of runtimeIdentityChecks) {
    if (actual === undefined || expected === undefined) {
      errors.push(`producer contract-set is missing its ${label} identity.`);
    } else if (actual !== expected) {
      errors.push(
        `producer contract-set ${label} is mixed: expected ${expected}, found ${actual}.`,
      );
    }
  }

  const definitions = new Map(
    CAPTURE_RUNTIME_CONSUMER_INVENTORY_FIELDS.map((definition) => [
      definition.key,
      definition,
    ]),
  );
  const observed = new Map<
    CaptureRuntimeConsumerInventoryKey,
    CaptureRuntimeConsumerInventoryEntry
  >();
  for (const entry of entries) {
    if (!definitions.has(entry.key)) {
      errors.push(`unexpected inventory owner ${entry.key}.`);
      continue;
    }
    if (observed.has(entry.key)) {
      errors.push(`duplicate inventory owner ${entry.key}.`);
      continue;
    }
    observed.set(entry.key, entry);
  }
  for (const definition of CAPTURE_RUNTIME_CONSUMER_INVENTORY_FIELDS) {
    const entry = observed.get(definition.key);
    if (!entry || entry.value === undefined) {
      errors.push(`missing inventory owner ${definition.key}.`);
      continue;
    }
    const expected =
      definition.kind === 'runtimeVersion'
        ? parsedContract.runtimeVersion
        : definition.kind === 'apiVersion'
          ? CAPTURE_RUNTIME_API_VERSION_FLOOR
          : definition.kind === 'documentSchemaVersion'
            ? CAPTURE_DOCUMENT_SCHEMA_VERSION_FLOOR
            : definition.kind === 'runtimeProvenanceIdentity'
              ? parsedContract.runtimeVersion === undefined
                ? undefined
                : `runtime=${parsedContract.runtimeVersion};wheel=${parsedContract.runtimeVersion}`
              : definition.kind === 'runtimeReadyIdentity'
                ? identityTuple(
                    {
                      runtimeVersion: undefined,
                      apiVersion: CAPTURE_RUNTIME_API_VERSION_FLOOR,
                      documentSchemaVersion:
                        CAPTURE_DOCUMENT_SCHEMA_VERSION_FLOOR,
                      contractSetVersion: CAPTURE_RUNTIME_CONTRACT_SET_VERSION,
                    },
                    true,
                  )
                : definition.kind === 'preflightIdentity'
                  ? identityTuple(
                      {
                        // 0.4.4 pins runtimeVersion in the producer preflight
                        // schema; the generated view must mirror the contract.
                        runtimeVersion: parsedContract.preflightRuntimeVersion,
                        apiVersion: CAPTURE_RUNTIME_API_VERSION_FLOOR,
                        contractSetVersion:
                          CAPTURE_RUNTIME_CONTRACT_SET_VERSION,
                      },
                      true,
                    )
                  : 'structural';
    if (expected === undefined) {
      errors.push(
        `${entry.source} cannot be validated because producer runtime identity is missing.`,
      );
      continue;
    }
    if (entry.value !== expected) {
      errors.push(
        `${entry.source} is stale or mixed: expected ${expected}, found ${entry.value}.`,
      );
    }
  }

  const observedRuntimeVersion = entries.find(
    (entry) => entry.key === 'cert.version.runtime',
  )?.value;
  return {
    status: errors.length === 0 ? 'ready' : 'blocked',
    expectedRuntimeVersion: parsedContract.runtimeVersion,
    expectedApiVersion: CAPTURE_RUNTIME_API_VERSION_FLOOR,
    expectedDocumentSchemaVersion: CAPTURE_DOCUMENT_SCHEMA_VERSION_FLOOR,
    expectedContractSetVersion: CAPTURE_RUNTIME_CONTRACT_SET_VERSION,
    observedRuntimeVersion,
    contractSource: contract.source,
    contractSetSha256,
    contractSchemaNames: parsedContract.schemaNames,
    ocrProjectionSchemaVersion: parsedContract.ocrProjectionSchemaVersion,
    entries,
    errors,
  };
}

export function assertCaptureRuntimeConsumerInventory(
  input: CaptureRuntimeConsumerInventoryInput,
): CaptureRuntimeConsumerInventoryReport {
  const report = inspectCaptureRuntimeConsumerInventory(input);
  if (report.status === 'blocked') {
    throw new Error(
      `Capture Runtime consumer inventory blocked before mutation:\n- ${report.errors.join('\n- ')}`,
    );
  }
  return report;
}

function assertCandidateInstallVersions(workspaceRoot: string): void {
  for (const packageName of [
    CAPTURE_RUNTIME_PACKAGE_NAME,
    CAPTURE_RUNTIME_CLIENT_PACKAGE_NAME,
  ]) {
    const manifestPath = join(
      workspaceRoot,
      'node_modules',
      ...packageName.split('/'),
      'package.json',
    );
    if (!existsSync(manifestPath)) {
      throw new Error(`${packageName} candidate install manifest is missing.`);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      version?: unknown;
    };
    if (manifest.version !== CAPTURE_RUNTIME_VERSION) {
      throw new Error(
        `${packageName} candidate install must be ${CAPTURE_RUNTIME_VERSION}.`,
      );
    }
  }
}

function requirePublishedCaptureArtifacts(workspaceRoot: string): void {
  const escapedRuntimeVersion = CAPTURE_RUNTIME_VERSION.replaceAll('.', '\\.');
  const pyproject = read(
    workspaceRoot,
    'apps/cert-prep-backend/pyproject.toml',
  );
  if (
    !new RegExp(`capture-runtime-client==${escapedRuntimeVersion}`, 'u').test(
      pyproject,
    )
  ) {
    throw new Error(
      `cert-prep backend must pin capture-runtime-client ${CAPTURE_RUNTIME_VERSION} from PyPI.`,
    );
  }
  const uvLock = read(workspaceRoot, 'apps/cert-prep-backend/uv.lock');
  const capturePackageBlock =
    /\[\[package\]\][\s\S]*?name = "capture-runtime-client"[\s\S]*?(?=\n\[\[package\]\]|$)/u.exec(
      uvLock,
    )?.[0] ?? '';
  if (
    !capturePackageBlock.includes(`version = "${CAPTURE_RUNTIME_VERSION}"`) ||
    !capturePackageBlock.includes(
      'source = { registry = "https://pypi.org/simple" }',
    )
  ) {
    throw new Error(
      'cert-prep uv.lock must resolve capture packages from PyPI, not a directory source.',
    );
  }

  const cargoToml = read(
    workspaceRoot,
    'apps/cert-prep-desktop/src-tauri/Cargo.toml',
  );
  if (/capture-sidecar-launcher\s*=\s*\{[^}]*path\s*=/u.test(cargoToml)) {
    throw new Error('cert-prep desktop launcher must come from crates.io.');
  }
  const cargoLock = read(
    workspaceRoot,
    'apps/cert-prep-desktop/src-tauri/Cargo.lock',
  );
  const launcherBlock =
    cargoLock.match(
      /\[\[package\]\][\s\S]*?name = "capture-sidecar-launcher"[\s\S]*?(?=\n\[\[package\]\]|$)/u,
    )?.[0] ?? '';
  if (
    !launcherBlock.includes(
      `version = "${CAPTURE_SIDECAR_LAUNCHER_VERSION}"`,
    ) ||
    !launcherBlock.includes(
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
    )
  ) {
    throw new Error(
      'cert-prep Cargo.lock must resolve capture-sidecar-launcher from crates.io at the pinned version.',
    );
  }
}

export function assertCaptureRuntimeConsumerVersions(
  workspaceRoot = resolve('.'),
  options: { readonly contractSource?: CaptureRuntimeContractSource } = {},
): void {
  if (process.env.CAPTURE_CANDIDATE_INSTALL === '1') {
    if (!options.contractSource) {
      throw new Error(
        'Candidate install version check requires a producer contract identity source before candidate checks.',
      );
    }
    assertCaptureRuntimeConsumerInventory(
      readCaptureRuntimeConsumerInventory(
        workspaceRoot,
        options.contractSource,
      ),
    );
    assertCandidateInstallVersions(workspaceRoot);
    return;
  }
  if (readCaptureVersion(read(workspaceRoot, 'tools/capture-runtime-version.json')) !== CAPTURE_RUNTIME_VERSION) {
    throw new Error('Capture adoption source changed; restart the version command.');
  }
  const packageManifest = JSON.parse(read(workspaceRoot, 'package.json')) as {
    dependencies?: Record<string, unknown>;
  };
  if (
    packageManifest.dependencies?.[CAPTURE_RUNTIME_PACKAGE_NAME] !==
    CAPTURE_RUNTIME_VERSION
  ) {
    throw new Error(
      `${CAPTURE_RUNTIME_PACKAGE_NAME} must be pinned to ${CAPTURE_RUNTIME_VERSION}.`,
    );
  }

  requireMatch(
    workspaceRoot,
    'pnpm-workspace.yaml',
    new RegExp(
      `${CAPTURE_RUNTIME_PACKAGE_NAME.replace('/', '\\/')}@${CAPTURE_RUNTIME_VERSION}`,
    ),
  );
  requireMatch(
    workspaceRoot,
    'pnpm-workspace.yaml',
    new RegExp(
      `${CAPTURE_RUNTIME_CLIENT_PACKAGE_NAME.replace('/', '\\/')}@${CAPTURE_RUNTIME_VERSION}`,
    ),
  );
  const pnpmLock = read(workspaceRoot, 'pnpm-lock.yaml');
  const retiredContractsMarker = ['capture', 'contracts'].join('-');
  if (pnpmLock.includes(retiredContractsMarker)) {
    throw new Error(
      'pnpm-lock.yaml must not resolve the retired public contracts package.',
    );
  }
  const hasPublishedNpmResolution = [
    CAPTURE_RUNTIME_PACKAGE_NAME,
    CAPTURE_RUNTIME_CLIENT_PACKAGE_NAME,
  ].every((packageName) =>
    pnpmLock.includes(
      `tarball: https://npm.pkg.github.com/download/${packageName}/${CAPTURE_RUNTIME_VERSION}/`,
    ),
  );
  if (!hasPublishedNpmResolution) {
    throw new Error(
      `pnpm-lock.yaml must resolve the published Capture Workbench ${CAPTURE_RUNTIME_VERSION} packages.`,
    );
  }

  requireMatch(
    workspaceRoot,
    'apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/runtime_policy.py',
    /SUPPORTED_RUNTIME_VERSION = CAPTURE_RUNTIME_VERSION/u,
  );
  requireNotExists(
    workspaceRoot,
    'apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/contracts.py',
  );
  const pyproject = read(
    workspaceRoot,
    'apps/cert-prep-backend/pyproject.toml',
  );
  const escapedRuntimeVersion = CAPTURE_RUNTIME_VERSION.replaceAll('.', '\\.');
  const hasPublishedPythonResolution = new RegExp(
    `capture-runtime-client==${escapedRuntimeVersion}`,
    'u',
  ).test(pyproject);
  if (!hasPublishedPythonResolution) {
    throw new Error(
      `cert-prep backend must resolve Capture Python packages from the published ${CAPTURE_RUNTIME_VERSION} release.`,
    );
  }
  requireMatch(
    workspaceRoot,
    'apps/cert-prep-backend/uv.lock',
    new RegExp(
      `name = "capture-runtime-client"[\\s\\S]*?version = "${CAPTURE_RUNTIME_VERSION}"`,
    ),
  );
  requireMatch(
    workspaceRoot,
    'apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/mapping.py',
    /from capture_runtime_client import/u,
  );
  requireMatch(
    workspaceRoot,
    'apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/client.py',
    /SdkCaptureRuntimeClient/,
  );
  requireMatch(
    workspaceRoot,
    'apps/cert-prep-desktop/src-tauri/src/constants.rs',
    /CAPTURE_RUNTIME_VERSION: &str = env!\("CERT_PREP_CAPTURE_RUNTIME_VERSION"\)/u,
  );
  requireMatch(
    workspaceRoot,
    'apps/cert-prep-desktop/project.json',
    /"outputs": \["\{workspaceRoot\}\/tmp\/cert-prep\/capture-runtime"\]/u,
  );
  requireMatch(
    workspaceRoot,
    'apps/cert-prep-desktop/scripts/package-qa/constants.mts',
    /from ['"]\.\.\/\.\.\/\.\.\/\.\.\/tools\/capture-runtime-version\.mts['"]/,
  );
  requireMatch(
    workspaceRoot,
    'tools/install-capture-runtime.mts',
    /from ['"]\.\/capture-runtime-version\.mts['"]/,
  );
  requireMatch(
    workspaceRoot,
    'tools/capture-runtime-consumer-smoke.mts',
    /const PUBLISHED_RELEASE_BASE_URL = CAPTURE_RUNTIME_RELEASE_BASE_URL;/,
  );
  requireMatch(
    workspaceRoot,
    'apps/cert-prep/src/app/pages/capture-workbench-trial/cert-prep-capture-client.ts',
    /assertCaptureRuntimeCompatible\(ready, CAPTURE_RUNTIME_MAJOR, 'host'\)/,
  );
  requireMatch(
    workspaceRoot,
    'apps/cert-prep-desktop/src-tauri/Cargo.toml',
    new RegExp(
      `capture-sidecar-launcher\\s*=\\s*(?:["']=${CAPTURE_SIDECAR_LAUNCHER_VERSION.replaceAll('.', '\\.')}["']|\\{[\\s\\S]*?version\\s*=\\s*["']=${CAPTURE_SIDECAR_LAUNCHER_VERSION.replaceAll('.', '\\.')}["'])`,
    ),
  );
  requirePublishedCaptureArtifacts(workspaceRoot);
}
