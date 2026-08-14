import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = (
  optionValue('--registry') ??
  process.env.CAPTURE_WORKBENCH_LOCAL_REGISTRY ??
  'http://127.0.0.1:4873'
).replace(/\/$/, '');
const packageSpec = optionValue('--package-spec') ?? 'local';
const fixtureBase = resolve(tmpdir(), 'cert-prep-capture-workbench-trials');
mkdirSync(fixtureBase, { recursive: true });
const fixtureRoot = mkdtempSync(join(fixtureBase, 'trial-'));
const corepackCli = join(
  dirname(process.execPath),
  'node_modules',
  'corepack',
  'dist',
  'corepack.js',
);

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--'))
    throw new Error(`${name} requires a value.`);
  return value;
}

function write(relativePath: string, contents: string): void {
  const target = join(fixtureRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        CI: 'true',
        npm_config_registry: registry,
        npm_config_userconfig: join(fixtureRoot, '.npmrc'),
      },
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolvePromise();
      reject(
        new Error(
          `${command} ${args.join(' ')} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`,
        ),
      );
    });
  });
}

function runPnpm(args: string[]): Promise<void> {
  if (!existsSync(corepackCli))
    throw new Error('Node 24 Corepack is required to run the pnpm 11 trial.');
  return run(process.execPath, [corepackCli, 'pnpm', ...args]);
}

function cleanup(): void {
  const resolvedFixture = resolve(fixtureRoot);
  const resolvedBase = resolve(fixtureBase);
  const relativeFixture = relative(resolvedBase, resolvedFixture);
  if (
    !relativeFixture ||
    relativeFixture === '..' ||
    relativeFixture.startsWith(`..${sep}`) ||
    isAbsolute(relativeFixture) ||
    !resolvedFixture.startsWith(`${resolvedBase}${sep}`)
  )
    throw new Error(
      `Refusing to remove unexpected fixture path: ${resolvedFixture}`,
    );
  rmSync(resolvedFixture, { recursive: true, force: true });
}

function createFixture(): void {
  write(
    'package.json',
    `${JSON.stringify(
      {
        name: 'cert-prep-capture-workbench-registry-trial',
        version: '0.0.0',
        private: true,
        type: 'module',
        packageManager: 'pnpm@11.15.1',
        engines: { node: '>=24.0.0', pnpm: '>=11.0.0' },
        scripts: { build: 'vite build' },
        dependencies: {
          '@angular/common': '22.0.7',
          '@angular/compiler': '22.0.7',
          '@angular/core': '22.0.7',
          '@angular/forms': '22.0.7',
          '@angular/platform-browser': '22.0.7',
          '@gx-capture/capture-workbench-ui': packageSpec,
          rxjs: '7.8.2',
          tslib: '2.8.1',
        },
        devDependencies: { typescript: '6.0.3', vite: '7.3.6' },
      },
      null,
      2,
    )}\n`,
  );
  write(
    'pnpm-workspace.yaml',
    `engineStrict: true\nallowBuilds:\n  '@parcel/watcher': true\n  '@swc/core': true\n  esbuild: true\n  lmdb: true\n  msgpackr-extract: true\n`,
  );
  write('.npmrc', `registry=${registry}\n@gx-capture:registry=${registry}\n`);
  write(
    'index.html',
    `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>cert-prep Capture Workbench registry trial</title></head><body><capture-workbench></capture-workbench><script type="module" src="/src/main.ts"></script></body></html>\n`,
  );
  write(
    'src/main.ts',
    `import { CAPTURE_WORKBENCH_CUSTOM_EVENTS, defineCaptureWorkbenchElement, type CaptureWorkbenchElement } from '@gx-capture/capture-workbench-ui';\n\ndefineCaptureWorkbenchElement().subscribe({\n  next: () => {\n    const capture = document.querySelector('capture-workbench') as CaptureWorkbenchElement | null;\n    if (!capture) throw new Error('Capture Workbench element was not mounted.');\n    capture.config = { outputMode: 'text', showRuntimeSetup: false };\n    capture.client = null;\n    capture.addEventListener(CAPTURE_WORKBENCH_CUSTOM_EVENTS.completed, (event) => console.log('capture-completed', event));\n  },\n  error: (error) => console.error('Element registration failed:', error),\n});\n`,
  );
  write(
    'vite.config.ts',
    `import { defineConfig } from 'vite';\nexport default defineConfig({ build: { outDir: 'dist', emptyOutDir: true } });\n`,
  );
}

async function main(): Promise<void> {
  createFixture();
  await runPnpm(['install', '--no-frozen-lockfile']);
  const installedManifestPath = join(
    fixtureRoot,
    'node_modules/@gx-capture/capture-workbench-ui/package.json',
  );
  if (!existsSync(installedManifestPath))
    throw new Error(
      'The local registry install did not produce node_modules/@gx-capture/capture-workbench-ui.',
    );
  const installedManifest = JSON.parse(
    readFileSync(installedManifestPath, 'utf8'),
  ) as { name?: string; version?: string };
  if (installedManifest.name !== '@gx-capture/capture-workbench-ui')
    throw new Error('The installed package has an unexpected package name.');
  await runPnpm(['exec', 'vite', 'build']);
  if (!existsSync(join(fixtureRoot, 'dist/index.html')))
    throw new Error(
      'The registry-installed consumer did not produce dist/index.html.',
    );
  process.stdout.write(
    `cert-prep local registry trial passed for ${installedManifest.name}@${installedManifest.version} from ${registry}.\n`,
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(cleanup);
