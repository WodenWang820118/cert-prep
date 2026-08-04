import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
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
    new RegExp(`${CAPTURE_RUNTIME_PACKAGE_NAME.replace('/', '\\/')}@${CAPTURE_RUNTIME_VERSION}`),
  );
  requireMatch(
    workspaceRoot,
    'pnpm-lock.yaml',
    new RegExp(
      `specifier: ${CAPTURE_RUNTIME_VERSION}[\\s\\S]*${CAPTURE_RUNTIME_PACKAGE_NAME.replace('/', '\\/')}@${CAPTURE_RUNTIME_VERSION}[\\s\\S]*capture-workbench\\/${CAPTURE_RUNTIME_VERSION}\\/`,
    ),
  );

  requireMatch(
    workspaceRoot,
    'apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/contracts.py',
    new RegExp(`SUPPORTED_RUNTIME_VERSION = ["']${CAPTURE_RUNTIME_VERSION}["']`),
  );
  requireMatch(
    workspaceRoot,
    'apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/client.py',
    /ready\.runtime_version != SUPPORTED_RUNTIME_VERSION/,
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
    /from ['"]\.\.\/\.\.\/\.\.\/\.\.\/tools\/capture-runtime-version\.mts['"]/
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
    'apps/cert-prep/src/app/pages/capture-workbench-trial/cert-prep-capture-client.ts',
    /ready\.runtimeVersion !== CAPTURE_RUNTIME_VERSION/,
  );
}
