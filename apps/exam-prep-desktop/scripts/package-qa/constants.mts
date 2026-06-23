import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TARGET_TRIPLE = 'x86_64-pc-windows-msvc';
export const DEFAULT_OUTPUT =
  'tmp/exam-prep-desktop/package-qa/package-qa.json';
export const DEFAULT_BUNDLE_ROOT = `apps/exam-prep-desktop/src-tauri/target/${DEFAULT_TARGET_TRIPLE}/release/bundle`;
export const DEFAULT_BACKEND_RUNTIME_ROOT =
  'apps/exam-prep-backend/dist/backend-runtime';
export const DEFAULT_BACKEND_RUNTIME_MANIFEST =
  'apps/exam-prep-desktop/src-tauri/resources/backend-runtime-manifest.json';
export const DEFAULT_BACKEND_RUNTIME_ENTRYPOINT =
  'apps/exam-prep-backend/dist/exam-prep-backend.exe';
export const DEFAULT_OCR_RUNTIME_ROOT =
  'apps/exam-prep-backend/dist/ocr-runtime';
export const DEFAULT_OCR_RUNTIME_MANIFEST =
  'apps/exam-prep-desktop/src-tauri/resources/ocr-runtime-manifest.json';
export const DEFAULT_DIRECTML_OCR_RUNTIME_ROOT =
  'apps/exam-prep-backend/dist/ocr-directml-runtime';
export const DEFAULT_DIRECTML_OCR_RUNTIME_MANIFEST =
  'apps/exam-prep-desktop/src-tauri/resources/directml-ocr-runtime-manifest.json';
export const DEFAULT_AMD_NPU_OCR_RUNTIME_ROOT =
  'apps/exam-prep-backend/dist/ocr-amd-npu-runtime';
export const DEFAULT_AMD_NPU_OCR_RUNTIME_MANIFEST =
  'apps/exam-prep-desktop/src-tauri/resources/amd-npu-ocr-runtime-manifest.json';
export const DEFAULT_DATA_DIR = 'tmp/exam-prep-desktop/package-qa/data';
export const DEFAULT_LLM_MODEL = 'qwen3.5:4b';
export const PACKAGE_QA_OCR_PAGE_WORKERS_ENV =
  'EXAM_PREP_PACKAGE_QA_OCR_PAGE_WORKERS';
export const BACKEND_RUNTIME_PREFIX = 'exam-prep-backend-runtime-';
export const OCR_RUNTIME_PREFIX = 'exam-prep-ocr-runtime-';
export const DIRECTML_OCR_RUNTIME_PREFIX = 'exam-prep-ocr-directml-runtime-';
export const AMD_NPU_OCR_RUNTIME_PREFIX = 'exam-prep-ocr-amd-npu-runtime-';
export const CAPTURE_LIMIT = 12_000;
export const INITIAL_INSTALLER_WARNING_MB = 150;
export const INITIAL_INSTALLER_ERROR_MB = 250;

const moduleDir = dirname(fileURLToPath(import.meta.url));

export const defaultWorkspaceRoot = resolve(moduleDir, '../../../..');
