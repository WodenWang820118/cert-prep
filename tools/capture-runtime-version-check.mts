import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  CAPTURE_SIDECAR_LAUNCHER_VERSION,
  CAPTURE_RUNTIME_CLIENT_PACKAGE_NAME,
  CAPTURE_RUNTIME_PACKAGE_NAME,
  CAPTURE_RUNTIME_VERSION,
} from './capture-runtime-version.mts';

function read(workspaceRoot: string, relativePath: string): string {
  return readFileSync(join(workspaceRoot, relativePath), 'utf8');
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

function requirePublishedCaptureArtifacts(workspaceRoot: string): void {
  if (process.env.CAPTURE_REQUIRE_PUBLISHED_CAPTURE_ARTIFACTS !== '1') {
    return;
  }

  const pyproject = read(
    workspaceRoot,
    'apps/cert-prep-backend/pyproject.toml',
  );
  if (
    /capture-(?:runtime-client|structuring)\s*=\s*\{[^}]*path\s*=/u.test(
      pyproject,
    )
  ) {
    throw new Error(
      'cert-prep backend capture Python dependencies must come from PyPI.',
    );
  }
  const uvLock = read(workspaceRoot, 'apps/cert-prep-backend/uv.lock');
  if (
    /capture-(?:runtime-client|structuring)[\s\S]{0,240}directory\s*=/u.test(
      uvLock,
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
): void {
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
  const hasPublishedNpmResolution = new RegExp(
    `specifier: ${CAPTURE_RUNTIME_VERSION}[\\s\\S]*${CAPTURE_RUNTIME_PACKAGE_NAME.replace('/', '\\/')}@${CAPTURE_RUNTIME_VERSION}[\\s\\S]*capture-workbench\\/${CAPTURE_RUNTIME_VERSION}\\/`,
  ).test(pnpmLock);
  if (
    !hasPublishedNpmResolution &&
    process.env.CAPTURE_REQUIRE_PUBLISHED_CAPTURE_ARTIFACTS === '1'
  ) {
    throw new Error(
      `pnpm-lock.yaml must resolve the published Capture Workbench ${CAPTURE_RUNTIME_VERSION} packages when published artifacts are required.`,
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
  const escapedRuntimeVersion = CAPTURE_RUNTIME_VERSION.replaceAll(
    '.',
    '\\.',
  );
  const hasPublishedPythonResolution = new RegExp(
    `capture-runtime-client>=${escapedRuntimeVersion},<0\\.4\\.0[\\s\\S]*capture-structuring>=${escapedRuntimeVersion},<0\\.4\\.0`,
    'u',
  ).test(pyproject);
  const hasLocalPythonResolution =
    /capture-runtime-client\s*=\s*\{[^}]*path\s*=\s*"\.\.\/\.\.\/\.\.\/capture-workbench\/packages\/capture-runtime-client-python"/u.test(
      pyproject,
    ) &&
    /capture-structuring\s*=\s*\{[^}]*path\s*=\s*"\.\.\/\.\.\/\.\.\/capture-workbench\/packages\/capture-structuring-python"/u.test(
      pyproject,
    );
  if (
    !hasPublishedPythonResolution &&
    !hasLocalPythonResolution
  ) {
    throw new Error(
      `cert-prep backend must resolve Capture Python packages from the published ${CAPTURE_RUNTIME_VERSION} release or the explicit local sibling source bridge.`,
    );
  }
  requireMatch(
    workspaceRoot,
    'apps/cert-prep-backend/uv.lock',
    new RegExp(
      `name = "capture-runtime-client"[\\s\\S]*?version = "${CAPTURE_RUNTIME_VERSION}"[\\s\\S]*?name = "capture-structuring"[\\s\\S]*?version = "${CAPTURE_RUNTIME_VERSION}"`,
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
    new RegExp(`CAPTURE_RUNTIME_VERSION: &str = "${CAPTURE_RUNTIME_VERSION}"`),
  );
  requireMatch(
    workspaceRoot,
    'apps/cert-prep-desktop/project.json',
    new RegExp(`capture-runtime\\/${CAPTURE_RUNTIME_VERSION}`),
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
    'tools/install-local-capture-workbench.mts',
    /CAPTURE_RUNTIME_PACKAGE_NAME[\s\S]*CAPTURE_RUNTIME_VERSION/,
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
      `capture-sidecar-launcher\\s*=\\s*(?:["']${CAPTURE_SIDECAR_LAUNCHER_VERSION.replaceAll('.', '\\.')}["']|\\{[\\s\\S]*?version\\s*=\\s*["']${CAPTURE_SIDECAR_LAUNCHER_VERSION.replaceAll('.', '\\.')}["'])`,
    ),
  );
  requirePublishedCaptureArtifacts(workspaceRoot);
}
