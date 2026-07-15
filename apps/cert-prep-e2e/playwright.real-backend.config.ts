import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { workspaceRoot } from '@nx/devkit';

const frontendUrl = 'http://localhost:4200';
const dataDir = join(
  workspaceRoot,
  'tmp',
  'cert-prep-e2e',
  'real-backend',
  String(process.pid),
);

rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

export default defineConfig({
  testDir: './src/real-backend',
  outputDir: '../../dist/.playwright/apps/cert-prep-e2e/real-backend-output',
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI']
    ? [['github'], ['html', { open: 'never' }]]
    : 'list',
  use: {
    baseURL: frontendUrl,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command:
        'pnpm nx run-many --target=serve --projects=cert-prep,cert-prep-backend --parallel=2',
      url: frontendUrl,
      cwd: workspaceRoot,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        CERT_PREP_API_TOKEN: 'real-e2e-token',
        CERT_PREP_DATA_DIR: dataDir,
        CERT_PREP_LLM_PROVIDER: 'fake',
        CERT_PREP_OCR_PROVIDER: 'fake',
        CERT_PREP_OCR_RUNTIME_MODE: 'inprocess',
        CERT_PREP_DOCUMENT_OCR_PARALLELISM: '1',
        CERT_PREP_STREAMING_DRAFT_WORKERS: '1',
        PYTHONPATH: join(workspaceRoot, 'apps', 'cert-prep-backend', 'src'),
      },
    },
    {
      command: 'node src/real-backend/backend-proxy.mts',
      url: 'http://127.0.0.1:8766/__e2e/health',
      cwd: join(workspaceRoot, 'apps', 'cert-prep-e2e'),
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        ...process.env,
        CERT_PREP_E2E_BACKEND_URL: 'http://127.0.0.1:8765',
        CERT_PREP_E2E_PROXY_PORT: '8766',
      },
    },
  ],
  projects: [
    {
      name: 'chromium-real-backend',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
