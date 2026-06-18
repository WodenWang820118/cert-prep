import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, '../../..');
const sourcePath = join(
  workspaceRoot,
  'apps/exam-prep-backend/dist/backend-runtime/backend-runtime-manifest.json',
);
const resourceDir = join(
  workspaceRoot,
  'apps/exam-prep-desktop/src-tauri/resources',
);
const targetPath = join(resourceDir, 'backend-runtime-manifest.json');

if (!existsSync(sourcePath)) {
  throw new Error(`Backend runtime manifest was not built: ${sourcePath}`);
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
console.log(`Synced backend runtime manifest to ${targetPath}`);
