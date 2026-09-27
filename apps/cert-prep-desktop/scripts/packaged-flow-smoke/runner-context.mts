import { appendFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium, type Locator, type Page } from 'playwright';

import { errorMessage, normalizePath } from './text-utils.mts';
import { redact } from '../acceptance-artifacts.mts';
import type { SmokeRunState } from './types.mts';

export const ACCEPTANCE_PRIVATE_SCREENSHOT_SELECTORS = [
  '.project-name',
  '.project-title',
  '[aria-label="Selected source file upload status"]',
  // Mask the bounded scroll container, not individual chunks: OCR strings
  // without wrapping opportunities can render outside a child bounding box.
  '.workbench-preview-list',
  '.analysis-text',
  '.review-block pre',
  'textarea[data-testid="raw-extracted-text"]',
  'textarea[data-testid="corrected-text"]',
  // Generated strings can overflow individual title/choice/rationale boxes;
  // mask the complete card so screenshots never retain partial content.
  '[data-testid="draft-question-card"]',
  '.practice-select-field select',
  '.practice-question-card',
  '.wrong-answer-card',
  '[data-testid="capture-result"]',
  // The native Capture Workbench module owns its internal markup and can
  // change selectors independently. Mask its whole host plus Cert Prep's
  // adjacent status/result containers so filenames and OCR text cannot leak
  // through a stale child selector.
  'capture-workbench',
  '.capture-trial-status',
  '.capture-trial-result',
] as const;

const ACCEPTANCE_REDACTION_ONLY_SELECTORS = [
  '.workbench-file-name',
  '.workbench-field select',
] as const;

export const ACCEPTANCE_REDACTION_STYLE = `
  ${[...ACCEPTANCE_PRIVATE_SCREENSHOT_SELECTORS, ...ACCEPTANCE_REDACTION_ONLY_SELECTORS].join(',\n  ')},
  ${[...ACCEPTANCE_PRIVATE_SCREENSHOT_SELECTORS, ...ACCEPTANCE_REDACTION_ONLY_SELECTORS].map((selector) => `${selector} *`).join(',\n  ')} {
    color: transparent !important;
    text-shadow: none !important;
    caret-color: transparent !important;
  }
`;

export function acceptancePrivacyMasks(page: Page): Locator[] {
  return [
    ...ACCEPTANCE_PRIVATE_SCREENSHOT_SELECTORS.map((selector) =>
      page.locator(selector),
    ),
    page
      .locator('.workbench-file-name')
      .filter({ hasNotText: 'No source file selected' }),
    page
      .locator('.workbench-field')
      .filter({ hasText: /Project source library/u }),
  ];
}

export function log(run: SmokeRunState, message: string): void {
  console.log(`[qa] ${message}`);
  appendFileSync(
    join(run.options.outDir, 'run.log'),
    `${new Date().toISOString()} ${redact(message)}\n`,
  );
}

export function activePage(run: SmokeRunState): Page {
  if (!run.page) {
    throw new Error('The packaged app page is not connected.');
  }
  return run.page;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function fetchJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForCdp(
  run: SmokeRunState,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const version = await fetchJson(
      `http://127.0.0.1:${run.port}/json/version`,
    );
    if (version) {
      return;
    }
    // WebView2 publishes the browser endpoint before its first page navigates.
    // Poll tightly so the caller can attach during that short window; waiting
    // hundreds of milliseconds can make Playwright's CDP handshake race the
    // navigation and hang on a blank page.
    await delay(25);
  }
  throw new Error(`Timed out waiting for WebView2 CDP on port ${run.port}`);
}

/**
 * Attach during WebView2's short pre-navigation window. A plain
 * wait-then-connect sequence can observe the endpoint only after the page
 * navigation has started; WebView2 then leaves Playwright's browser-level CDP
 * handshake pending indefinitely. Retrying the attach from the first healthy
 * endpoint avoids that race while retaining a bounded timeout.
 */
export async function connectOverCdpEarly(
  run: SmokeRunState,
  timeoutMs = 90_000,
): Promise<Awaited<ReturnType<typeof chromium.connectOverCDP>>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    const version = await fetchJson(
      `http://127.0.0.1:${run.port}/json/version`,
    );
    if (version) {
      try {
        return await chromium.connectOverCDP(`http://127.0.0.1:${run.port}`, {
          timeout: 1_000,
        });
      } catch (error) {
        lastError = error;
      }
    }
    await delay(25);
  }
  throw new Error(
    `Timed out attaching to WebView2 CDP on port ${run.port}: ${errorMessage(lastError)}`,
  );
}

export async function bodyText(run: SmokeRunState): Promise<string> {
  if (!run.page) {
    return '';
  }
  try {
    return await run.page.evaluate(() => document.body?.innerText ?? '');
  } catch (error) {
    if (errorMessage(error).includes('Execution context was destroyed')) {
      await delay(500);
      return '';
    }
    throw error;
  }
}

export async function waitText(
  run: SmokeRunState,
  pattern: RegExp,
  timeoutMs: number,
  label: string,
): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const text = await bodyText(run);
    if (pattern.test(text)) {
      const elapsed = Date.now() - start;
      log(run, `${label} after ${elapsed}ms`);
      return elapsed;
    }
    await delay(500);
  }
  const text = await bodyText(run);
  throw new Error(
    `Timed out waiting for ${label}. Pattern=${pattern}. Body=${text.slice(0, 1400)}`,
  );
}

export async function waitLocatorText(
  locator: Locator,
  pattern: RegExp,
  timeoutMs: number,
  label: string,
): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const text = await locator.innerText();
      if (pattern.test(text)) return Date.now() - start;
    } catch (error) {
      if (!errorMessage(error).includes('Execution context was destroyed')) {
        throw error;
      }
    }
    await delay(500);
  }
  let text = '';
  try {
    text = await locator.innerText();
  } catch {
    // Keep the timeout error deterministic when the page is navigating.
  }
  throw new Error(
    `Timed out waiting for ${label}. Pattern=${pattern}. Text=${text.slice(0, 1400)}`,
  );
}

export function metricText(value: unknown): string {
  return Array.from(String(value ?? ''))
    .map((character) => {
      const code = character.charCodeAt(0);
      if (
        code <= 0x1f ||
        (code >= 0x7f && code <= 0x9f) ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        return ' ';
      }
      return character;
    })
    .join('')
    .trim()
    .slice(0, 200);
}

export async function screenshot(
  run: SmokeRunState,
  name: string,
): Promise<void> {
  const file = join(
    run.options.outDir,
    `${String(run.metrics.screenshots.length + 1).padStart(2, '0')}-${name}.png`,
  );
  const page = activePage(run);
  await page.screenshot({
    path: file,
    fullPage: true,
    ...(run.options.acceptanceArtifactRoot
      ? { mask: acceptancePrivacyMasks(page), maskColor: '#000000' }
      : {}),
  });
  run.metrics.screenshots.push(
    normalizePath(relative(run.options.workspaceRoot, file)),
  );
  await run.options.acceptanceVisualCheckpoint?.(page, name);
  log(run, `screenshot ${file.split(/[\\/]/).pop() ?? name}`);
}

export async function startAcceptanceCapture(
  run: SmokeRunState,
): Promise<void> {
  if (!run.options.acceptanceArtifactRoot || run.acceptanceCaptureActive) {
    return;
  }
  const context = run.browser?.contexts()[0];
  const page = run.page;
  if (!context || !page) {
    throw new Error(
      'Acceptance capture requires a connected packaged-app page.',
    );
  }
  run.acceptanceVideoPaths ??= [];
  run.acceptanceTracePaths ??= [];
  run.acceptanceTraceOwned = false;
  run.acceptanceConsoleErrors ??= [];
  run.acceptancePageErrors ??= [];
  run.acceptanceCaptureSequence = (run.acceptanceCaptureSequence ?? 0) + 1;
  const sequence = String(run.acceptanceCaptureSequence).padStart(2, '0');
  const tracePath = join(
    run.options.acceptanceArtifactRoot,
    `trace-${sequence}.zip`,
  );
  // Traces retain DOM snapshots and can contain raw OCR/evidence text. The
  // acceptance contract publishes redacted screenshots and structured reports
  // instead of a trace archive.
  void tracePath;
  if (run.options.acceptanceRecordVideo) {
    await page.addInitScript((content) => {
      const install = (): void => {
        if (!document.documentElement || document.querySelector('[data-cert-prep-acceptance-redaction]')) {
          return;
        }
        const style = document.createElement('style');
        style.setAttribute('data-cert-prep-acceptance-redaction', 'true');
        style.textContent = content;
        document.documentElement.append(style);
      };
      install();
      new MutationObserver(install).observe(document, { childList: true, subtree: true });
    }, ACCEPTANCE_REDACTION_STYLE);
    let styleInstalled = false;
    for (let attempt = 0; attempt < 6 && !styleInstalled; attempt += 1) {
      try {
        await page.addStyleTag({ content: ACCEPTANCE_REDACTION_STYLE });
        styleInstalled = true;
      } catch (error) {
        if (
          !errorMessage(error).includes('Execution context was destroyed') ||
          attempt === 5
        ) {
          throw error;
        }
        await delay(250);
        await page
          .waitForLoadState('domcontentloaded', { timeout: 5_000 })
          .catch(() => undefined);
      }
    }
  }
  page.on('console', (message) => {
    if (message.type() === 'error')
      run.acceptanceConsoleErrors?.push(message.text());
  });
  page.on('pageerror', (error) =>
    run.acceptancePageErrors?.push(error.message),
  );
  if (run.options.acceptanceRecordVideo) {
    const videoPath = join(
      run.options.acceptanceArtifactRoot,
      `cert-prep-golden-journey-${sequence}.webm`,
    );
    run.acceptanceVideoPaths.push(videoPath);
    await page.screencast.start({
      path: videoPath,
      size: { width: 1440, height: 900 },
    });
  }
  run.acceptanceCaptureActive = true;
}

export async function stopAcceptanceCapture(run: SmokeRunState): Promise<void> {
  if (!run.acceptanceCaptureActive) return;
  const context = run.browser?.contexts()[0];
  const page = run.page;
  run.acceptanceCaptureActive = false;
  if (page && run.options.acceptanceRecordVideo) {
    await page.screencast.stop().catch((error: unknown) => {
      run.metrics.errors.push(
        `acceptance video stop failed: ${errorMessage(error)}`,
      );
    });
  }
  if (context && run.acceptanceTracePaths?.length) {
    const tracePath =
      run.acceptanceTracePaths[run.acceptanceTracePaths.length - 1];
    if (run.acceptanceTraceOwned) {
      await context.tracing
        .stop({ path: tracePath })
        .catch((error: unknown) => {
          run.metrics.errors.push(
            `acceptance trace stop failed: ${errorMessage(error)}`,
          );
        });
      run.acceptanceTraceOwned = false;
    }
  }
}

export async function clickButtonText(
  run: SmokeRunState,
  text: string,
  buttonOptions: { timeout?: number; exact?: boolean; force?: boolean } = {},
): Promise<void> {
  const timeout = buttonOptions.timeout ?? 20_000;
  const pattern = buttonOptions.exact
    ? new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`)
    : text;
  const locator = activePage(run)
    .locator('button')
    .filter({ hasText: pattern })
    .first();
  await locator.waitFor({ state: 'visible', timeout });
  await locator.click({ timeout, force: buttonOptions.force ?? false });
}

export async function clickButtonPattern(
  run: SmokeRunState,
  pattern: RegExp,
  buttonOptions: { timeout?: number; force?: boolean } = {},
): Promise<void> {
  const timeout = buttonOptions.timeout ?? 20_000;
  const locator = activePage(run)
    .locator('button, a')
    .filter({ hasText: pattern })
    .first();
  await locator.waitFor({ state: 'visible', timeout });
  await locator.click({ timeout, force: buttonOptions.force ?? false });
}

export async function clickConsentInstall(run: SmokeRunState): Promise<void> {
  const buttons = activePage(run)
    .locator('button')
    .filter({ hasText: /^\s*Install\s*$/ });
  const count = await buttons.count();
  if (count === 0) {
    throw new Error('No Install consent button found');
  }
  await buttons.nth(count - 1).evaluate((button) => {
    if (button instanceof HTMLElement) {
      button.click();
      return;
    }
    button.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  });
}

export async function openRuntimeDrawer(run: SmokeRunState): Promise<void> {
  if ((await runtimeDrawerLocator(run).count()) > 0) {
    return;
  }
  await clickButtonText(run, 'Manage runtime');
  await runtimeDrawerLocator(run).waitFor({
    state: 'visible',
    timeout: 10_000,
  });
  const elapsed = await waitText(
    run,
    /Python backend|Developer backend|Ollama/i,
    10_000,
    'runtime view visible',
  );
  log(run, `runtime view locator visible after ${elapsed}ms`);
}

function runtimeDrawerLocator(run: SmokeRunState): Locator {
  return activePage(run)
    .locator('[aria-label="Runtime details"], .p-dialog, [role="dialog"]')
    .filter({
      hasText: /Python backend|Developer backend|Ollama|Runtime details/i,
    })
    .last();
}

function closeableRuntimeDialogLocator(run: SmokeRunState): Locator {
  return activePage(run)
    .locator('.p-dialog, [role="dialog"]')
    .filter({
      hasText: /Manage runtime|Runtime details|Python backend|Ollama/i,
    })
    .last();
}

export async function runtimeDrawerText(run: SmokeRunState): Promise<string> {
  await openRuntimeDrawer(run);
  const drawer = runtimeDrawerLocator(run);
  await drawer.waitFor({ state: 'visible', timeout: 10_000 });
  return drawer.innerText({ timeout: 10_000 });
}

export async function waitRuntimeDrawerText(
  run: SmokeRunState,
  pattern: RegExp,
  timeoutMs: number,
  label: string,
): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const text = await runtimeDrawerText(run);
    if (pattern.test(text)) {
      const elapsed = Date.now() - start;
      log(run, `${label} after ${elapsed}ms`);
      return elapsed;
    }
    await delay(500);
  }
  const text = await runtimeDrawerText(run);
  throw new Error(
    `Timed out waiting for ${label}. Pattern=${pattern}. Drawer=${text.slice(0, 1400)}`,
  );
}

export async function closeRuntimeDrawer(run: SmokeRunState): Promise<void> {
  const drawer = runtimeDrawerLocator(run);
  if ((await drawer.count()) === 0) {
    return;
  }
  const dialog = closeableRuntimeDialogLocator(run);
  const dialogCount = await dialog.count();
  if (dialogCount === 0) {
    await clickButtonPattern(run, /^\s*Build\s*$/);
    await waitText(
      run,
      /Projects|Create project|Recent projects|Local Workspace/i,
      10_000,
      'workspace view visible',
    );
    return;
  }
  const closeButtons = dialog
    .locator(
      'button[aria-label="Close runtime manager"]:not([aria-hidden="true"]), button[aria-label="Close"]:not([aria-hidden="true"]), button.p-dialog-header-close:not([aria-hidden="true"])',
    )
    .filter({ visible: true });
  const count = await closeButtons.count();
  if (count > 0) {
    await closeButtons.last().click({ force: true });
  } else {
    await activePage(run).keyboard.press('Escape');
  }
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
}

export async function refreshRuntimeDrawer(run: SmokeRunState): Promise<void> {
  await openRuntimeDrawer(run);
  const refresh = activePage(run)
    .locator('button')
    .filter({ hasText: /^\s*Refresh(?: all)?\s*$/ })
    .first();
  try {
    await refresh.waitFor({ state: 'visible', timeout: 10_000 });
    await refresh.click({ timeout: 10_000 });
  } catch (error) {
    run.metrics.observations.push(
      `Runtime refresh skipped or disabled: ${errorMessage(error)}`,
    );
  }
  await delay(2_500);
}
