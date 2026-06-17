import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
copyFileSync(sourcePath, targetPath);
console.log(`Synced backend runtime manifest to ${targetPath}`);
