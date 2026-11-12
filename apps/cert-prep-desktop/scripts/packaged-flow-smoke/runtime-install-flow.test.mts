import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  captureRuntimeInstallationCompleted,
  pythonRuntimeReadyPattern,
  pythonRuntimeStartupState,
} from './runtime-install-flow.mts';

test('Capture Runtime installation accepts its completed terminal status', () => {
  assert.equal(captureRuntimeInstallationCompleted('completed'), true);
  assert.equal(captureRuntimeInstallationCompleted('succeeded'), true);
  assert.equal(captureRuntimeInstallationCompleted('running'), false);
  assert.equal(captureRuntimeInstallationCompleted(null), false);
});

test('python runtime readiness requires a backend-ready detail', () => {
  for (const text of [
    'Projects',
    'Select or create a project',
    'Workspace ready',
    'Python 3.12',
    'Python backend runtime installation queued.',
    'Status: Python backend runtime is ready.',
    'Python backend runtime is ready. Continue',
    'Python 3.12.12 / development',
  ]) {
    assert.equal(pythonRuntimeReadyPattern().test(text), false, text);
  }

  for (const text of [
    'Python backend runtime is ready.',
    'Python backend runtime is running.',
    'Python backend runtime is already running.',
    'Python 3.12.12 / packaged',
  ]) {
    assert.equal(pythonRuntimeReadyPattern().test(text), true, text);
  }

  assert.equal(
    pythonRuntimeReadyPattern().test(
      'Python backend\r\n  Python backend runtime is ready.  \r\nOllama',
    ),
    true,
  );
});

test('python runtime startup state waits through the initial shell race', () => {
  assert.equal(pythonRuntimeStartupState('Cert Prep\nProjects'), 'pending');
  assert.equal(
    pythonRuntimeStartupState(
      'Python backend runtime is not installed.\nInstall runtime',
    ),
    'installable',
  );
  assert.equal(
    pythonRuntimeStartupState(
      'Python backend runtime is ready.\nInstall runtime',
    ),
    'ready',
  );
});
