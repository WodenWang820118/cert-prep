import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, '../../..');
const backendDist = join(workspaceRoot, 'apps/exam-prep-backend/dist');
const desktopBinaries = join(
  workspaceRoot,
  'apps/exam-prep-desktop/src-tauri/binaries'
);

const rustInfo = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
const targetTriple = rustInfo
  .split(/\r?\n/)
  .find(line => line.startsWith('host:'))
  ?.replace(/^host:\s*/, '');

if (!targetTriple) {
  throw new Error('Unable to determine Rust host target triple.');
}

const isWindows = process.platform === 'win32';
const sourceName = isWindows ? 'exam-prep-backend.exe' : 'exam-prep-backend';
const targetExtension = targetTriple.includes('windows') ? '.exe' : '';
const sourcePath = join(backendDist, sourceName);
const targetPath = join(
  desktopBinaries,
  `exam-prep-backend-${targetTriple}${targetExtension}`
);

if (!existsSync(sourcePath)) {
  throw new Error(`Backend sidecar was not built: ${sourcePath}`);
}

mkdirSync(desktopBinaries, { recursive: true });
copyFileSync(sourcePath, targetPath);
console.log(`Synced sidecar to ${targetPath}`);
