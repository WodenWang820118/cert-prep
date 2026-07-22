import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TARGET_TRIPLE = 'x86_64-pc-windows-msvc';
export const ALPHA_VERSION = '0.1.0-alpha.1';
export const PYTHON_RUNTIME_VERSION = '3.12';
export const CAPTURE_RUNTIME_VERSION = '0.1.0';
export const CAPTURE_RUNTIME_API_VERSION = '1.0';
export const CAPTURE_DOCUMENT_SCHEMA_VERSION = '1';
export const CAPTURE_RUNTIME_MANIFEST_VERSION = '1';
export const CAPTURE_RUNTIME_FILE =
  'capture-runtime-x86_64-pc-windows-msvc.exe';
export const CAPTURE_DOCUMENT_SCHEMA_FILE =
  'capture-document-v1.schema.json';
export const CAPTURE_DOCUMENT_SCHEMA_SHA256 =
  'da8565b0a4611042f62f96202d0f167ba0923d88e12b9be22832f3ee320920c3';
export const CAPTURE_WINDOWSML_BUNDLE_MAX_BYTES = 512 * 1024 * 1024;
export const DEFAULT_OUTPUT =
  'tmp/cert-prep-desktop/package-qa/package-qa.json';
export const DEFAULT_BUNDLE_ROOT = `apps/cert-prep-desktop/src-tauri/target/${DEFAULT_TARGET_TRIPLE}/release/bundle`;
export const DEFAULT_PACKAGED_RESOURCE_ROOT = `apps/cert-prep-desktop/src-tauri/target/${DEFAULT_TARGET_TRIPLE}/release/resources`;
export const DEFAULT_TAURI_CONFIG =
  'apps/cert-prep-desktop/src-tauri/tauri.conf.json';
export const DEFAULT_LLM_MODEL = 'qwen3.5:4b';
export const BACKEND_RUNTIME_PREFIX = `cert-prep-backend-runtime-${ALPHA_VERSION}-`;
export const WINDOWSML_OCR_RUNTIME_PREFIX = `cert-prep-ocr-windowsml-runtime-${ALPHA_VERSION}-`;
export const INITIAL_INSTALLER_WARNING_MB = 150;
export const INITIAL_INSTALLER_ERROR_MB = 250;

const moduleDir = dirname(fileURLToPath(import.meta.url));

export const defaultWorkspaceRoot = resolve(moduleDir, '../../../..');
