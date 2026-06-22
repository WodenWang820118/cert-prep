import { appendFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { Locator, Page } from 'playwright';

import { errorMessage, normalizePath } from './text-utils.mts';
import type { SmokeRunState } from './types.mts';

export function log(run: SmokeRunState, message: string): void {
  console.log(`[qa] ${message}`);
  appendFileSync(
    join(run.options.outDir, 'run.log'),
    `${new Date().toISOString()} ${message}\n`,
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
    const version = await fetchJson(`http://127.0.0.1:${run.port}/json/version`);
    if (version) {
      return;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for WebView2 CDP on port ${run.port}`);
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
  await activePage(run).screenshot({ path: file, fullPage: true });
  run.metrics.screenshots.push(normalizePath(relative(run.options.workspaceRoot, file)));
  log(run, `screenshot ${file.split(/[\\/]/).pop() ?? name}`);
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
    .locator('button')
    .filter({ hasText: pattern })
    .first();
  await locator.waitFor({ state: 'visible', timeout });
  await locator.click({ timeout, force: buttonOptions.force ?? false });
}

export async function clickConsentInstall(run: SmokeRunState): Promise<void> {
  const buttons = activePage(run)
    .locator('button')
    .filter({ hasText: /^s*Installs*$/ });
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
  if (/Runtime details/.test(await bodyText(run))) {
    return;
  }
  await clickButtonText(run, 'Manage runtime');
  await waitText(run, /Runtime details/, 10_000, 'runtime drawer visible');
}

export function runtimeDrawerLocator(run: SmokeRunState): Locator {
  return activePage(run)
    .locator('.p-dialog, [role="dialog"]')
    .filter({ hasText: /Runtime details/ })
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
  if (!/Runtime details/.test(await bodyText(run))) {
    return;
  }
  const closeButtons = activePage(run).locator(
    'button[aria-label="Close"], button.p-dialog-header-close',
  );
  const count = await closeButtons.count();
  if (count > 0) {
    await closeButtons.nth(count - 1).click({ force: true });
  } else {
    await activePage(run).keyboard.press('Escape');
  }
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    if (!/Runtime details/.test(await bodyText(run))) {
      return;
    }
    await delay(250);
  }
  throw new Error('Runtime drawer did not close');
}

export async function refreshRuntimeDrawer(run: SmokeRunState): Promise<void> {
  await openRuntimeDrawer(run);
  const refresh = activePage(run)
    .locator('button')
    .filter({ hasText: /^s*Refreshs*$/ })
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
