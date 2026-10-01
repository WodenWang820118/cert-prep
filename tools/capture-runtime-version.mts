import { readFileSync } from 'node:fs';
import { readCaptureVersion } from './capture-version-source.mts';

/**
 * Cert Prep's single source for the Capture Workbench release contract.
 *
 * Language-specific runtime constants remain embedded in the Python and Rust
 * products, but the consumer consistency gate verifies that they match this
 * value before a package or runtime can be consumed.
 */
export const CAPTURE_RUNTIME_PACKAGE_NAME =
  '@gx-capture/capture-workbench-ui' as const;
export const CAPTURE_RUNTIME_CLIENT_PACKAGE_NAME =
  '@gx-capture/capture-runtime-client' as const;
export const CAPTURE_RUNTIME_VERSION: string = readCaptureVersion(
  readFileSync(
    new URL('./capture-runtime-version.json', import.meta.url),
    'utf8',
  ),
);
export const CAPTURE_RUNTIME_MAJOR = Number(
  CAPTURE_RUNTIME_VERSION.split('.')[0],
);
export const CAPTURE_RUNTIME_API_VERSION = '2.0' as const;
export const CAPTURE_DOCUMENT_SCHEMA_VERSION = '2' as const;
export const CAPTURE_DOCUMENT_SCHEMA_FILE =
  'capture-document-v2.schema.json' as const;
export const CAPTURE_RUNTIME_RELEASE_BASE_URL =
  `https://github.com/gx-capture/capture-workbench/releases/download/v${CAPTURE_RUNTIME_VERSION}` as const;
export const CAPTURE_RUNTIME_MODEL =
  `capture-runtime@${CAPTURE_RUNTIME_VERSION}` as const;

export const CAPTURE_SIDECAR_LAUNCHER_VERSION = CAPTURE_RUNTIME_VERSION;

/** Immutable core-only release retained for compatibility-specific handling. */
export const LEGACY_CORE_ONLY_RUNTIME_VERSION = '0.3.8' as const;
