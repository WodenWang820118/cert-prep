import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, '../../..');
const sourcePath = join(
  workspaceRoot,
  'apps/exam-prep-backend/dist/ocr-amd-npu-runtime/amd-npu-ocr-runtime-manifest.json',
);
const resourceDir = join(
  workspaceRoot,
  'apps/exam-prep-desktop/src-tauri/resources',
);
const targetPath = join(resourceDir, 'amd-npu-ocr-runtime-manifest.json');

if (!existsSync(sourcePath)) {
  throw new Error(`AMD NPU OCR runtime manifest was not built: ${sourcePath}`);
}

mkdirSync(resourceDir, { recursive: true });
const manifest = JSON.parse(readFileSync(sourcePath, 'utf8')) as {
  artifact?: { file_name?: string; url?: string | null };
};
if (manifest.artifact && !manifest.artifact.url && manifest.artifact.file_name) {
  manifest.artifact.url = pathToFileURL(
    join(dirname(sourcePath), manifest.artifact.file_name),
  ).href;
}
writeFileSync(targetPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Synced AMD NPU OCR runtime manifest to ${targetPath}`);
