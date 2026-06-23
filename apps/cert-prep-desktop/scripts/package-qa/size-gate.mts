import {
  INITIAL_INSTALLER_ERROR_MB,
  INITIAL_INSTALLER_WARNING_MB,
} from './constants.mts';
import type { FileRecord, SizeGate } from './types.mts';

/** Evaluates the initial package size warning and failure thresholds. */
export function initialInstallerSizeGate(
  bundleArtifacts: readonly Pick<FileRecord, 'mb'>[],
): SizeGate {
  const largestInitialMb = Math.max(
    ...bundleArtifacts.map((artifact) => artifact.mb),
  );
  if (largestInitialMb > INITIAL_INSTALLER_ERROR_MB) {
    return {
      status: 'failed',
      largest_initial_mb: largestInitialMb,
      warning_mb: INITIAL_INSTALLER_WARNING_MB,
      error_mb: INITIAL_INSTALLER_ERROR_MB,
      detail: `Initial package is ${largestInitialMb} MB, above the ${INITIAL_INSTALLER_ERROR_MB} MB limit.`,
    };
  }
  if (largestInitialMb > INITIAL_INSTALLER_WARNING_MB) {
    return {
      status: 'warning',
      largest_initial_mb: largestInitialMb,
      warning_mb: INITIAL_INSTALLER_WARNING_MB,
      error_mb: INITIAL_INSTALLER_ERROR_MB,
      detail: `Initial package is ${largestInitialMb} MB, above the ${INITIAL_INSTALLER_WARNING_MB} MB warning threshold.`,
    };
  }
  return {
    status: 'passed',
    largest_initial_mb: largestInitialMb,
    warning_mb: INITIAL_INSTALLER_WARNING_MB,
    error_mb: INITIAL_INSTALLER_ERROR_MB,
    detail: 'Initial package size is within the configured gate.',
  };
}
