import {
  bodyText,
  clickButtonPattern,
  clickConsentInstall,
  openRuntimeDrawer,
  screenshot,
  waitRuntimeDrawerText,
  waitText,
} from './runner-context.mts';
import type { SmokeRunState } from './types.mts';

export async function installPythonRuntimeIfNeeded(run: SmokeRunState): Promise<void> {
  if (!/Install the Python backend runtime|Install runtime/.test(await bodyText(run))) {
    run.metrics.observations.push(
      'Python backend runtime was already available at QA start.',
    );
    return;
  }

  await screenshot(run, 'runtime-python-missing');
  await openRuntimeDrawer(run);
  await screenshot(run, 'runtime-drawer-python-missing');
  const start = Date.now();
  await clickButtonPattern(run, /^\s*Install runtime\s*$/);
  await waitText(run, /Install Python backend runtime/, 10_000, 'python install consent');
  await screenshot(run, 'python-install-consent');
  await clickConsentInstall(run);
  await waitRuntimeDrawerText(run,
    pythonRuntimeReadyPattern(),
    90_000,
    'python runtime ready',
  );
  run.metrics.ui_timings_ms.python_runtime_install = Date.now() - start;
  await screenshot(run, 'python-runtime-ready');
}

export function pythonRuntimeReadyPattern(): RegExp {
  return /(?:^|\r?\n)[^\S\r\n]*(?:Python backend runtime is (?:ready|running|already running)\.|Python \d+\.\d+(?:\.\d+)? \/ packaged)[^\S\r\n]*(?=\r?\n|$)/i;
}
