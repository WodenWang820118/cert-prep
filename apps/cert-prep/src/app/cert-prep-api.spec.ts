import { TestBed } from '@angular/core/testing';
import { CertPrepRuntimeConfig } from './cert-prep-api';

describe('CertPrepRuntimeConfig', () => {
  beforeEach(() => {
    localStorage.clear();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    TestBed.configureTestingModule({});
  });

  it('does not provide a static bearer token for browser fallback', async () => {
    const config = await TestBed.inject(
      CertPrepRuntimeConfig,
    ).getBackendConfig();

    expect(config).toEqual({
      base_url: 'http://127.0.0.1:8765',
      token: '',
    });
  });

  it('uses explicit local developer connection settings when provided', async () => {
    localStorage.setItem('certPrepApiBaseUrl', 'http://127.0.0.1:9001/');
    localStorage.setItem('certPrepApiToken', 'developer-token');

    const config = await TestBed.inject(
      CertPrepRuntimeConfig,
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
      TestBed.inject(CertPrepRuntimeConfig).getBackendConfig(),
    ).rejects.toThrow('Desktop backend configuration is unavailable.');
  });
});
