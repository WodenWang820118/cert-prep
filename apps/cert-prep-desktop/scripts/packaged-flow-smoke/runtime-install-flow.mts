import {
  bodyText,
  clickButtonPattern,
  clickConsentInstall,
  openRuntimeDrawer,
  refreshRuntimeDrawer,
  runtimeDrawerText,
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
  await waitText(run,
    /Projects|Select or create a project|Workspace ready|Python 3/,
    90_000,
    'python runtime ready',
  );
  run.metrics.ui_timings_ms.python_runtime_install = Date.now() - start;
  await screenshot(run, 'python-runtime-ready');
}

export async function installOcrRuntimeIfNeeded(run: SmokeRunState): Promise<void> {
  await openRuntimeDrawer(run);
  await refreshRuntimeDrawer(run);

  let text = await runtimeDrawerText(run);
  if (
    /Unknown|status unavailable|OCR unknown|PaddleOCR status unavailable|WindowsML OCR status unavailable/i.test(
      text,
    )
  ) {
    run.metrics.observations.push(
      'Runtime drawer showed OCR unknown after Python install; manual refresh was required.',
    );
    await refreshRuntimeDrawer(run);
    text = await runtimeDrawerText(run);
  }

  if (ocrReadyPattern().test(text)) {
    run.metrics.observations.push(
      'OCR runtime was already ready after runtime refresh.',
    );
    await screenshot(run, 'runtime-ocr-ready-after-refresh');
    return;
  }

  if (!ocrInstallablePattern().test(text)) {
    run.metrics.observations.push(
      'Waiting longer for OCR health to settle before treating the drawer as failed.',
    );
    await waitRuntimeDrawerText(run,
      ocrSettledPattern(),
      180_000,
      'ocr health settled',
    );
    text = await runtimeDrawerText(run);
  }

  if (ocrReadyPattern().test(text)) {
    run.metrics.observations.push(
      'OCR runtime became ready after delayed health settling.',
    );
    await screenshot(run, 'runtime-ocr-ready-after-delayed-health');
    return;
  }

  if (!ocrInstallablePattern().test(text)) {
    throw new Error(
      `OCR install action did not appear. Runtime drawer text: ${text.slice(0, 1400)}`,
    );
  }

  const start = Date.now();
  await clickButtonPattern(run, /^\s*Install OCR\s*$/);
  await waitText(run,
    /Install the (PaddleOCR|WindowsML OCR) runtime/,
    10_000,
    'ocr install consent',
  );
  await screenshot(run, 'ocr-install-consent');
  await clickConsentInstall(run);
  await waitText(run, ocrReadyPattern(), 900_000, 'ocr runtime ready');
  run.metrics.ui_timings_ms.paddleocr_runtime_install = Date.now() - start;
  await screenshot(run, 'runtime-checklist-ready');
}

function ocrInstallablePattern(): RegExp {
  return /Install OCR|PaddleOCR runtime is not installed|paddle_runtime_missing|WindowsML OCR runtime is not installed|windowsml_runtime_missing/i;
}

function ocrReadyPattern(): RegExp {
  return /PaddleOCR imports available|gpu:0|PaddleOCR runtime is ready|paddle\s*\/\s*(gpu|cpu)|WindowsML OCR runtime is ready|windowsml\s*\/\s*(amd_windowsml|windowsml|igpu)|OCR ready/i;
}

function ocrSettledPattern(): RegExp {
  return new RegExp(
    `${ocrReadyPattern().source}|${ocrInstallablePattern().source}`,
    'i',
  );
}
