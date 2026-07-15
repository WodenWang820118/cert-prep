import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';

import {
  ALPHA_VERSION,
  DEFAULT_BUNDLE_ROOT,
  DEFAULT_PACKAGED_RESOURCE_ROOT,
  DEFAULT_TAURI_CONFIG,
  DEFAULT_TARGET_TRIPLE,
  defaultWorkspaceRoot,
} from './constants.mts';
import {
  collectBundleArtifacts,
  normalizePath,
  publicFileRecord,
} from './files.mts';
import { validatePackagedResourceContract } from './resource-contract.mts';
import { initialInstallerSizeGate } from './size-gate.mts';
import type { PackageQaOptions, PackageQaReport } from './types.mts';

/** Creates the package QA JSON report without writing it to disk. */
export async function createPackageQaReport(
  options: PackageQaOptions = {},
): Promise<PackageQaReport> {
  const workspaceRoot = resolve(options.workspaceRoot ?? defaultWorkspaceRoot);
  const bundleRoot = resolve(
    workspaceRoot,
    options.bundleRoot ?? DEFAULT_BUNDLE_ROOT,
  );
  const expectedTargetTriple =
    options.expectedTargetTriple ?? DEFAULT_TARGET_TRIPLE;
  const packagedResourceRoot = resolve(
    workspaceRoot,
    options.packagedResourceRoot ?? DEFAULT_PACKAGED_RESOURCE_ROOT,
  );
  const tauriConfig = resolve(
    workspaceRoot,
    options.tauriConfig ?? DEFAULT_TAURI_CONFIG,
  );

  const bundleArtifacts = collectBundleArtifacts(bundleRoot, workspaceRoot);
  validateBundleArtifacts(bundleArtifacts, bundleRoot);

  const sizeGate = initialInstallerSizeGate(bundleArtifacts);
  const resourceContract = validatePackagedResourceContract({
    resourceRoot: packagedResourceRoot,
    tauriConfig,
    workspaceRoot,
    expectedTargetTriple,
  });
  const publicResourceContract = {
    ...resourceContract,
    distribution_profile: 'public_unsigned_alpha' as const,
    publishable: true as const,
  };

  return {
    schema_version: 3,
    generated_at: new Date().toISOString(),
    assessment: {
      status: 'blocked',
      evidence_scope: 'static_tauri_release_resources',
      blockers: [
        'installer_contents_not_verified',
        'fresh_install_not_verified',
      ],
    },
    target: {
      rust_triple: resourceContract.target,
      platform: process.platform,
      arch: process.arch,
    },
    package: {
      bundle_root: normalizePath(relative(workspaceRoot, bundleRoot)),
      bundle_artifacts: bundleArtifacts.map(publicFileRecord),
      packaged_resource_root: normalizePath(
        relative(workspaceRoot, packagedResourceRoot),
      ),
      resource_contract: publicResourceContract,
      size_gate: sizeGate,
    },
  };
}

export function validateBundleArtifacts(
  bundleArtifacts: readonly { readonly path: string }[],
  bundleRoot = 'bundle root',
): void {
  const msi = bundleArtifacts.filter((item) =>
    item.path.toLowerCase().endsWith('.msi'),
  );
  const nsis = bundleArtifacts.filter(
    (item) =>
      item.path.toLowerCase().endsWith('.exe') &&
      basename(item.path).toLowerCase().includes('setup'),
  );
  if (
    bundleArtifacts.length !== 2 ||
    msi.length !== 1 ||
    nsis.length !== 1 ||
    !msi[0].path.includes(ALPHA_VERSION) ||
    !nsis[0].path.includes(ALPHA_VERSION)
  ) {
    throw new Error(
      `Expected exactly one ${ALPHA_VERSION} MSI and one NSIS installer under ${bundleRoot}; stale or unexpected bundles are not allowed.`,
    );
  }
}

/** Writes a package QA report with the stable pretty-printed JSON format. */
export function writeReport(report: unknown, outputPath: string): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}
