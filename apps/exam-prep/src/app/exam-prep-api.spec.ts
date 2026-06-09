import { TestBed } from '@angular/core/testing';
import { ExamPrepRuntimeConfig } from './exam-prep-api';

describe('ExamPrepRuntimeConfig', () => {
  beforeEach(() => {
    localStorage.clear();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    TestBed.configureTestingModule({});
  });

  it('does not provide a static bearer token for browser fallback', async () => {
    const config = await TestBed.inject(
      ExamPrepRuntimeConfig,
    ).getBackendConfig();

    expect(config).toEqual({
      base_url: 'http://127.0.0.1:8765',
      token: '',
    });
  });

  it('uses explicit local developer connection settings when provided', async () => {
    localStorage.setItem('examPrepApiBaseUrl', 'http://127.0.0.1:9001/');
    localStorage.setItem('examPrepApiToken', 'developer-token');

    const config = await TestBed.inject(
      ExamPrepRuntimeConfig,
    ).getBackendConfig();

    expect(config).toEqual({
      base_url: 'http://127.0.0.1:9001/',
      token: 'developer-token',
    });
  });

  it('does not silently fall back when desktop config is present but unavailable', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });

    await expect(
      TestBed.inject(ExamPrepRuntimeConfig).getBackendConfig(),
    ).rejects.toThrow('Desktop backend configuration is unavailable.');
  });
});
