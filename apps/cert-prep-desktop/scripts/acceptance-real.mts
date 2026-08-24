import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  collectAcceptanceArtifactInputs,
  createAcceptanceRun,
  writeAcceptanceManifest,
} from './acceptance-artifacts.mts';

const workspaceRoot = resolve(import.meta.dirname, '../..', '..');
const recorded = process.argv.includes('--recorded');
const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
process.env.E2E_ACCEPTANCE_RUN_ID ||= `local-${timestamp}-${process.pid}`;
process.env.E2E_RECORD_VIDEO = recorded
  ? '1'
  : process.env.E2E_RECORD_VIDEO || '0';

const run = createAcceptanceRun(process.env, 'cert-prep', workspaceRoot);
const corepackPath = resolve(
  dirname(process.execPath),
  'node_modules/corepack/dist/corepack.js',
);
if (!existsSync(corepackPath)) {
  throw new Error(`Corepack entry point is missing: ${corepackPath}`);
}
const result = spawnSync(
  process.execPath,
  [
    corepackPath,
    'pnpm',
    'exec',
    'playwright',
    'test',
    '--config',
    'apps/cert-prep-desktop/playwright.acceptance.config.ts',
    'apps/cert-prep-desktop/scripts/acceptance-real.spec.mts',
    '--project=chromium',
  ],
  {
    cwd: workspaceRoot,
    env: process.env,
    stdio: 'inherit',
    shell: false,
    windowsHide: false,
  },
);
if (result.error) throw result.error;
const manifestPath = join(run.artifactRoot, 'acceptance-manifest.json');
await mkdir(run.artifactRoot, { recursive: true });
const existing = existsSync(manifestPath)
  ? (JSON.parse(await readFile(manifestPath, 'utf8')) as {
      status?: 'completed' | 'failed';
      errors?: string[];
      consoleErrors?: string[];
      pageErrors?: string[];
      cleanup?: Record<string, boolean>;
      fixture?: { name: string; sha256: string };
      fixtures?: Record<string, unknown>;
      runtime?: Record<string, unknown>;
    })
  : undefined;
const sourceSuitePath = join(run.artifactRoot, 'acceptance-sources.json');
const sourceSuite = existsSync(sourceSuitePath)
  ? (JSON.parse(await readFile(sourceSuitePath, 'utf8')) as {
      status?: 'completed' | 'failed';
      pdf?: {
        fixture?: Record<string, unknown>;
        status?: string;
        errors?: string[];
        restartVerified?: boolean;
      };
      image?: {
        fixture?: Record<string, unknown>;
        status?: string;
        cleanup?: Record<string, boolean>;
        cleanupVerified?: boolean;
        error?: string;
      };
      runtime?: Record<string, unknown>;
      fixtures?: Record<string, unknown>;
    })
  : undefined;
const exitCode = result.status ?? 1;
const imageCleanup = sourceSuite?.image?.cleanup ?? {
  app: sourceSuite?.image?.cleanupVerified === true,
  sidecar: sourceSuite?.image?.cleanupVerified === true,
  cdpPort: sourceSuite?.image?.cleanupVerified === true,
  temporaryAppData: sourceSuite?.image?.cleanupVerified === true,
};
const cleanup = {
  ...(existing?.cleanup ?? {
    app: false,
    sidecar: false,
    cdpPort: false,
    temporaryAppData: false,
  }),
  imageApp: imageCleanup.app === true,
  imageSidecar: imageCleanup.sidecar === true,
  imageCdpPort: imageCleanup.cdpPort === true,
  imageTemporaryAppData: imageCleanup.temporaryAppData === true,
};
const cleanupComplete = Object.values(cleanup).every(Boolean);
const errors = [
  ...(existing?.errors ?? []),
  ...(exitCode === 0
    ? []
    : [`Cert Prep acceptance Playwright exited with ${exitCode}.`]),
  ...(sourceSuite?.status === 'completed'
    ? []
    : ['PDF and JPEG acceptance source suite did not complete.']),
  ...(sourceSuite?.image?.error ? [sourceSuite.image.error] : []),
  ...(sourceSuite?.pdf?.status === 'failed'
    ? (sourceSuite.pdf.errors ?? ['PDF acceptance journey failed.'])
    : []),
];
const acceptancePassed =
  exitCode === 0 &&
  existing?.status === 'completed' &&
  sourceSuite?.status === 'completed' &&
  sourceSuite.image?.status === 'completed' &&
  cleanupComplete &&
  errors.length === 0 &&
  (existing?.consoleErrors?.length ?? 0) === 0 &&
  (existing?.pageErrors?.length ?? 0) === 0;
await writeAcceptanceManifest(run.artifactRoot, {
  project: run.project,
  runId: run.runId,
  status: acceptancePassed ? 'completed' : 'failed',
  recordVideo: run.recordVideo,
    artifacts: await collectAcceptanceArtifactInputs(run.artifactRoot),
    errors,
    consoleErrors: existing?.consoleErrors ?? [],
    pageErrors: existing?.pageErrors ?? [],
    cleanup,
    fixture: existing?.fixture,
    fixtures: sourceSuite
      ? {
          pdf: sourceSuite.pdf?.fixture,
          image: sourceSuite.image?.fixture,
          runtime: sourceSuite.runtime,
        }
      : undefined,
  });
if (!acceptancePassed) {
  throw new Error(
    `Cert Prep acceptance did not complete truthfully (Playwright=${exitCode}, manifest=${existing?.status ?? 'failed'}).`,
  );
}
