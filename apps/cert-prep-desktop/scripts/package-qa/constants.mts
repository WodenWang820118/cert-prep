import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TARGET_TRIPLE = 'x86_64-pc-windows-msvc';
export const DEFAULT_OUTPUT =
  'tmp/cert-prep-desktop/package-qa/package-qa.json';
export const DEFAULT_BUNDLE_ROOT = `apps/cert-prep-desktop/src-tauri/target/${DEFAULT_TARGET_TRIPLE}/release/bundle`;
export const DEFAULT_BACKEND_RUNTIME_ROOT =
  'apps/cert-prep-backend/dist/backend-runtime';
export const DEFAULT_BACKEND_RUNTIME_MANIFEST =
  'apps/cert-prep-desktop/src-tauri/resources/backend-runtime-manifest.json';
export const DEFAULT_BACKEND_RUNTIME_ENTRYPOINT =
  'apps/cert-prep-backend/dist/cert-prep-backend.exe';
export const DEFAULT_WINDOWSML_OCR_RUNTIME_ROOT =
  'apps/cert-prep-backend/dist/ocr-windowsml-runtime';
export const DEFAULT_WINDOWSML_OCR_RUNTIME_MANIFEST =
  'apps/cert-prep-desktop/src-tauri/resources/windowsml-ocr-runtime-manifest.json';
export const DEFAULT_DATA_DIR = 'tmp/cert-prep-desktop/package-qa/data';
export const DEFAULT_LLM_MODEL = 'qwen3.5:4b';
export const PACKAGE_QA_OCR_PAGE_WORKERS_ENV =
  'CERT_PREP_PACKAGE_QA_OCR_PAGE_WORKERS';
export const BACKEND_RUNTIME_PREFIX = 'cert-prep-backend-runtime-';
export const WINDOWSML_OCR_RUNTIME_PREFIX = 'cert-prep-ocr-windowsml-runtime-';
export const CAPTURE_LIMIT = 12_000;
export const INITIAL_INSTALLER_WARNING_MB = 150;
export const INITIAL_INSTALLER_ERROR_MB = 250;

const moduleDir = dirname(fileURLToPath(import.meta.url));

export const defaultWorkspaceRoot = resolve(moduleDir, '../../../..');
