import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveWindowsPowerShellExecutable } from './processes.mts';
import type { BackendRuntimeManifest, SmokeMetrics } from './types.mts';

const PROCESS_SNAPSHOT_MAX_BUFFER = 64 * 1024 * 1024;

interface PrepareBackendRuntimeOptions {
  workspaceRoot: string;
  outDir: string;
  metrics: SmokeMetrics;
}

/** Syncs the packaged backend runtime into the isolated QA app data directory. */
export function preparePackagedBackendRuntimeForSmoke({
  workspaceRoot,
  outDir,
  metrics,
}: PrepareBackendRuntimeOptions): void {
  const manifestPath = resolve(
    workspaceRoot,
    'apps/exam-prep-desktop/src-tauri/resources/backend-runtime-manifest.json',
  );
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing backend runtime manifest: ${manifestPath}`);
  }

  const manifest = parseBackendRuntimeManifest(readFileSync(manifestPath, 'utf8'));
  if (manifest.kind !== 'python_backend') {
    throw new Error(`Unsupported backend runtime kind: ${manifest.kind}`);
  }

  const artifactPath = resolveBackendRuntimeArtifact(workspaceRoot, manifest);
  verifyBackendRuntimeArtifact(artifactPath, manifest);

  const appDataRoot = packagedAppDataDir();
  const runtimeRoot = join(appDataRoot, 'runtimes');
  const runtimeDir = join(runtimeRoot, 'python_backend');
  const extractDir = join(outDir, 'backend-runtime-extract');

  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  expandArchive(workspaceRoot, artifactPath, extractDir);

  const entrypoint = join(extractDir, manifest.entrypoint);
  if (!existsSync(entrypoint)) {
    throw new Error(
      `Backend runtime archive did not contain entrypoint: ${manifest.entrypoint}`,
    );
  }

  rmSync(runtimeDir, { recursive: true, force: true });
  mkdirSync(runtimeRoot, { recursive: true });
  renameSync(extractDir, runtimeDir);
  writeFileSync(
    join(runtimeDir, 'runtime-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  metrics.observations.push(
    `Packaged smoke synced backend runtime ${manifest.artifact.sha256.slice(
      0,
      12,
    )} into app data.`,
  );
}

/** Resolves the packaged app data directory used by runtime discovery. */
export function packagedAppDataDir(): string {
  const override = process.env.EXAM_PREP_PACKAGE_SMOKE_APP_DATA_DIR?.trim();
  if (override) {
    return resolve(override);
  }

  const appData = process.env.APPDATA?.trim();
  if (!appData) {
    throw new Error('APPDATA is required to prepare packaged smoke runtime.');
  }
  return join(appData, 'dev.certprep.exam-prep');
}

function parseBackendRuntimeManifest(raw: string): BackendRuntimeManifest {
  const value = JSON.parse(raw) as Partial<BackendRuntimeManifest>;
  if (
    typeof value.kind !== 'string' ||
    typeof value.version !== 'string' ||
    typeof value.target !== 'string' ||
    typeof value.entrypoint !== 'string' ||
    typeof value.artifact !== 'object' ||
    value.artifact === null ||
    typeof value.artifact.file_name !== 'string' ||
    typeof value.artifact.sha256 !== 'string' ||
    typeof value.artifact.bytes !== 'number'
  ) {
    throw new Error('Backend runtime manifest is missing required fields.');
  }
  return value as BackendRuntimeManifest;
}

function resolveBackendRuntimeArtifact(
  workspaceRoot: string,
  manifest: BackendRuntimeManifest,
): string {
  if (manifest.artifact.url?.startsWith('file://')) {
    return fileURLToPath(manifest.artifact.url);
  }

  return resolve(
    workspaceRoot,
    'apps/exam-prep-backend/dist/backend-runtime',
    manifest.artifact.file_name,
  );
}

function verifyBackendRuntimeArtifact(
  artifactPath: string,
  manifest: BackendRuntimeManifest,
): void {
  if (!existsSync(artifactPath)) {
    throw new Error(`Missing backend runtime artifact: ${artifactPath}`);
  }

  const size = statSync(artifactPath).size;
  if (size !== manifest.artifact.bytes) {
    throw new Error(
      `Backend runtime artifact size mismatch: expected ${manifest.artifact.bytes}, got ${size}.`,
    );
  }

  const actualHash = sha256File(artifactPath);
  if (actualHash.toLowerCase() !== manifest.artifact.sha256.toLowerCase()) {
    throw new Error(
      `Backend runtime artifact sha256 mismatch: expected ${manifest.artifact.sha256}, got ${actualHash}.`,
    );
  }
}

function expandArchive(
  workspaceRoot: string,
  archivePath: string,
  destinationPath: string,
): void {
  const result = spawnSync(
    resolveWindowsPowerShellExecutable(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath ${powerShellString(
        archivePath,
      )} -DestinationPath ${powerShellString(destinationPath)} -Force`,
    ],
    {
      cwd: workspaceRoot,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: PROCESS_SNAPSHOT_MAX_BUFFER,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Failed to extract backend runtime artifact: ${result.stderr || result.stdout}`,
    );
  }
}

function powerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}
