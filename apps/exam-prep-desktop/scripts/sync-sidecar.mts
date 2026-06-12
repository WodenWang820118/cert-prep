import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIDECAR_PATTERN = /^exam-prep-backend-.+(?:\.exe)?$/;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, '../../..');
const backendDist = join(workspaceRoot, 'apps/exam-prep-backend/dist');
const desktopBinaries = join(
  workspaceRoot,
  'apps/exam-prep-desktop/src-tauri/binaries'
);

const targetTriple = targetFromArgs(process.argv.slice(2)) ?? rustHostTriple();

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
removeStaleSidecars(desktopBinaries);
copyFileSync(sourcePath, targetPath);
console.log(`Synced sidecar to ${targetPath}`);

function targetFromArgs(args: readonly string[]): string | undefined {
  const targetIndex = args.indexOf('--target');
  if (targetIndex >= 0) {
    const target = args[targetIndex + 1];
    if (!target) {
      throw new Error('--target requires a Rust target triple.');
    }
    return target;
  }
  const inlineTarget = args.find(arg => arg.startsWith('--target='));
  return inlineTarget?.slice('--target='.length);
}

function rustHostTriple(): string | undefined {
  const rustInfo = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  return rustInfo
    .split(/\r?\n/)
    .find(line => line.startsWith('host:'))
    ?.replace(/^host:\s*/, '');
}

function removeStaleSidecars(directory: string): void {
  for (const entry of readdirSync(directory)) {
    if (SIDECAR_PATTERN.test(entry)) {
      rmSync(join(directory, entry), { force: true });
    }
  }
}
