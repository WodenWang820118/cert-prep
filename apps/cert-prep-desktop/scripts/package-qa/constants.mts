import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TARGET_TRIPLE = 'x86_64-pc-windows-msvc';
export const ALPHA_VERSION = '0.1.0-alpha.1';
export const PYTHON_RUNTIME_VERSION = '3.12';
export const CAPTURE_RUNTIME_VERSION = '0.3.8';
export const CAPTURE_RUNTIME_API_VERSION = '1.0';
export const CAPTURE_DOCUMENT_SCHEMA_VERSION = '1';
export const CAPTURE_RUNTIME_MANIFEST_VERSION = '1';
export const CAPTURE_RUNTIME_FILE =
  'capture-runtime-x86_64-pc-windows-msvc.exe';
export const CAPTURE_DOCUMENT_SCHEMA_FILE =
  'capture-document-v1.schema.json';
export const CAPTURE_DOCUMENT_SCHEMA_SHA256 =
  '2721093496a9f09044d5737cce70d2356d5f71757b1cd23a960e1d003ea014f2';
export const CAPTURE_RUNTIME_MAX_BYTES = 512 * 1024 * 1024;
export const DEFAULT_OUTPUT =
  'tmp/cert-prep-desktop/package-qa/package-qa.json';
export const DEFAULT_BUNDLE_ROOT = `apps/cert-prep-desktop/src-tauri/target/${DEFAULT_TARGET_TRIPLE}/release/bundle`;
export const DEFAULT_PACKAGED_RESOURCE_ROOT = `apps/cert-prep-desktop/src-tauri/target/${DEFAULT_TARGET_TRIPLE}/release/resources`;
export const DEFAULT_TAURI_CONFIG =
  'apps/cert-prep-desktop/src-tauri/tauri.conf.json';
export const DEFAULT_LLM_MODEL = 'qwen3.5:4b';
export const BACKEND_RUNTIME_PREFIX = `cert-prep-backend-runtime-${ALPHA_VERSION}-`;
export const INITIAL_INSTALLER_WARNING_MB = 150;
export const INITIAL_INSTALLER_ERROR_MB = 250;

const moduleDir = dirname(fileURLToPath(import.meta.url));

export const defaultWorkspaceRoot = resolve(moduleDir, '../../../..');
