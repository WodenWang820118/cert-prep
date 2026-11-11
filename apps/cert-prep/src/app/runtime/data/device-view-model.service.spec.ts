import { describe, expect, it } from 'vitest';
import type { DevicePreferenceRead, OllamaDeviceRead } from '@cert-prep/api';
import { DEVICE_COPY } from '../domain';
import { DeviceViewModelService } from './device-view-model.service';

describe('DeviceViewModelService', () => {
  const service = new DeviceViewModelService();

  const samplePreference: DevicePreferenceRead = {
    mode: 'auto',
    adapter_key: null,
    adapter_name: null,
    status: 'active',
    choices: [
      {
        adapter_key: 'rtx-4090',
        name: 'NVIDIA GeForce RTX 4090',
        classification: 'dedicated',
        backend: 'cuda',
        selectable: true,
      },
      {
        adapter_key: 'uhd-770',
        name: 'Intel UHD Graphics 770',
        classification: 'integrated',
        backend: 'vulkan',
        selectable: true,
      },
      {
        adapter_key: 'unknown-gpu',
        name: 'Unknown Graphics Device',
        classification: 'unknown',
        backend: null,
        selectable: false,
      },
    ],
  };

  it('row 1: returns null when both device and preference are null (fake provider without preference)', () => {
    const vm = service.create(null, null, false, null);
    expect(vm).toBeNull();
  });

  it('row 1b: returns view model when device is null but preference is loaded', () => {
    const vm = service.create(null, samplePreference, false, null);
    expect(vm).not.toBeNull();
    expect(vm?.showChooser).toBe(true);
    expect(vm?.statusLine).toBeNull();
  });

  it('shows only health status without inventing a choice before preference is known', () => {
    const vm = service.create(
      {
        server: 'owned',
        requested: { target: 'cpu', backend: 'cpu', adapter_name: null },
        verification: 'verified',
        observed: {
          backend: 'cpu',
          adapter_name: null,
          offloaded_layers: 0,
          total_layers: 32,
        },
        corrective_restarts: 0,
      },
      null,
      false,
      null,
    );
    expect(vm?.showChooser).toBe(false);
    expect(vm?.options).toEqual([]);
    expect(vm?.selectedValue).toBeNull();
    expect(vm?.statusLine).toEqual({
      kind: 'verified',
      text: DEVICE_COPY.status.cpuVerified,
    });
  });

  it('row 2: not installed / not running returns server not running copy', () => {
    const device: OllamaDeviceRead = {
      server: 'not_running',
      requested: null,
      verification: 'not_observable',
      observed: null,
      corrective_restarts: 0,
    };
    const vm = service.create(device, samplePreference, false, null);
    expect(vm?.statusLine).toEqual({
      kind: 'not_running',
      text: DEVICE_COPY.status.serverNotRunning,
    });
  });

  it('row 3: owned before first load returns pending verification copy', () => {
    const device: OllamaDeviceRead = {
      server: 'owned',
      requested: {
        target: 'dedicated_gpu',
        backend: 'cuda',
        adapter_name: 'NVIDIA GeForce RTX 4090',
      },
      verification: 'pending',
      observed: null,
      corrective_restarts: 0,
    };
    const vm = service.create(device, samplePreference, false, null);
    expect(vm?.statusLine).toEqual({
      kind: 'pending',
      text: DEVICE_COPY.status.pendingVerification,
    });
  });

  it('row 4: owned and verified returns verified adapter copy', () => {
    const device: OllamaDeviceRead = {
      server: 'owned',
      requested: {
        target: 'dedicated_gpu',
        backend: 'cuda',
        adapter_name: 'NVIDIA GeForce RTX 4090',
      },
      verification: 'verified',
      observed: {
        backend: 'cuda',
        adapter_name: 'NVIDIA GeForce RTX 4090',
        offloaded_layers: 32,
        total_layers: 32,
      },
      corrective_restarts: 0,
    };
    const vm = service.create(device, samplePreference, false, null);
    expect(vm?.statusLine).toEqual({
      kind: 'verified',
      text: DEVICE_COPY.status.verified('NVIDIA GeForce RTX 4090'),
    });
  });

  it('row 5: mismatch restarted before reload returns pending verification copy', () => {
    const device: OllamaDeviceRead = {
      server: 'owned',
      requested: {
        target: 'dedicated_gpu',
        backend: 'cuda',
        adapter_name: 'NVIDIA GeForce RTX 4090',
      },
      verification: 'pending',
      observed: null,
      corrective_restarts: 1,
    };
    const vm = service.create(device, samplePreference, false, null);
    expect(vm?.statusLine).toEqual({
      kind: 'pending',
      text: DEVICE_COPY.status.pendingVerification,
    });
  });

  it('row 6: second mismatch returns requested vs observed copy', () => {
    const device: OllamaDeviceRead = {
      server: 'owned',
      requested: {
        target: 'dedicated_gpu',
        backend: 'cuda',
        adapter_name: 'NVIDIA GeForce RTX 4090',
      },
      verification: 'mismatch',
      observed: {
        backend: 'cpu',
        adapter_name: null,
        offloaded_layers: 0,
        total_layers: 32,
      },
      corrective_restarts: 1,
    };
    const vm = service.create(device, samplePreference, false, null);
    expect(vm?.statusLine).toEqual({
      kind: 'mismatch',
      text: DEVICE_COPY.status.mismatch('NVIDIA GeForce RTX 4090', 'CPU'),
    });
  });

  it('row 7: mismatch with no correction derivable returns mismatch copy', () => {
    const device: OllamaDeviceRead = {
      server: 'owned',
      requested: {
        target: 'dedicated_gpu',
        backend: 'cuda',
        adapter_name: 'NVIDIA GeForce RTX 3060',
      },
      verification: 'mismatch',
      observed: {
        backend: 'vulkan',
        adapter_name: 'Intel UHD Graphics 770',
        offloaded_layers: 16,
        total_layers: 32,
      },
      corrective_restarts: 0,
    };
    const vm = service.create(device, samplePreference, false, null);
    expect(vm?.statusLine).toEqual({
      kind: 'mismatch',
      text: DEVICE_COPY.status.mismatch(
        'NVIDIA GeForce RTX 3060',
        'Intel UHD Graphics 770',
      ),
    });
  });

  it('row 8: CPU chosen/override verified returns CPU verified copy', () => {
    const device: OllamaDeviceRead = {
      server: 'owned',
      requested: { target: 'cpu', backend: 'cpu', adapter_name: null },
      verification: 'verified',
      observed: {
        backend: 'cpu',
        adapter_name: null,
        offloaded_layers: 0,
        total_layers: 32,
      },
      corrective_restarts: 0,
    };
    const pref: DevicePreferenceRead = {
      ...samplePreference,
      mode: 'cpu',
    };
    const vm = service.create(device, pref, false, null);
    expect(vm?.selectedValue).toBe('cpu');
    expect(vm?.statusLine).toEqual({
      kind: 'verified',
      text: DEVICE_COPY.status.cpuVerified,
    });
  });

  it('row 9: unmanaged unknown class returns pending verification copy', () => {
    const device: OllamaDeviceRead = {
      server: 'owned',
      requested: { target: 'unmanaged', backend: null, adapter_name: null },
      verification: 'unknown',
      observed: {
        backend: 'vulkan',
        adapter_name: null,
        offloaded_layers: null,
        total_layers: null,
      },
      corrective_restarts: 0,
    };
    const vm = service.create(device, samplePreference, false, null);
    expect(vm?.statusLine).toEqual({
      kind: 'pending',
      text: DEVICE_COPY.status.pendingVerification,
    });
  });

  it('row 10: external server displays external guidance note and saved copy when status is external_server', () => {
    const device: OllamaDeviceRead = {
      server: 'external',
      requested: null,
      verification: 'not_observable',
      observed: null,
      corrective_restarts: 0,
    };
    const pref: DevicePreferenceRead = {
      ...samplePreference,
      status: 'external_server',
    };
    const vm = service.create(device, pref, false, null);
    expect(vm?.externalNote).toEqual({
      meaning: DEVICE_COPY.external.meaning,
      action: DEVICE_COPY.external.action,
    });
    expect(vm?.statusLine).toEqual({
      kind: 'saved_external',
      text: DEVICE_COPY.status.savedWhileExternal,
    });
  });

  it('row 11: preference pending switch displays pending switch copy', () => {
    const device: OllamaDeviceRead = {
      server: 'owned',
      requested: {
        target: 'dedicated_gpu',
        backend: 'cuda',
        adapter_name: 'NVIDIA GeForce RTX 4090',
      },
      verification: 'verified',
      observed: {
        backend: 'cuda',
        adapter_name: 'NVIDIA GeForce RTX 4090',
        offloaded_layers: 32,
        total_layers: 32,
      },
      corrective_restarts: 0,
    };
    const pref: DevicePreferenceRead = {
      ...samplePreference,
      mode: 'adapter',
      adapter_key: 'uhd-770',
      status: 'pending',
    };
    const vm = service.create(device, pref, false, null);
    expect(vm?.statusLine).toEqual({
      kind: 'pending',
      text: DEVICE_COPY.status.pendingSwitch,
    });
  });

  it('row 12: right after switched server starts displays pending verification copy', () => {
    const device: OllamaDeviceRead = {
      server: 'owned',
      requested: {
        target: 'integrated_gpu',
        backend: 'vulkan',
        adapter_name: 'Intel UHD Graphics 770',
      },
      verification: 'pending',
      observed: null,
      corrective_restarts: 0,
    };
    const pref: DevicePreferenceRead = {
      ...samplePreference,
      mode: 'adapter',
      adapter_key: 'uhd-770',
      status: 'active',
    };
    const vm = service.create(device, pref, false, null);
    expect(vm?.statusLine).toEqual({
      kind: 'pending',
      text: DEVICE_COPY.status.pendingVerification,
    });
  });

  it('handles preference status adapter_missing and adds missing adapter option before CPU', () => {
    const pref: DevicePreferenceRead = {
      ...samplePreference,
      mode: 'adapter',
      adapter_key: 'missing-card',
      adapter_name: 'NVIDIA GeForce RTX 3080',
      status: 'adapter_missing',
    };
    const vm = service.create(null, pref, false, null);
    expect(vm?.statusLine).toEqual({
      kind: 'adapter_missing',
      text: DEVICE_COPY.status.adapterMissing,
    });

    const options = vm?.options ?? [];
    // auto + 3 choices + 1 missing + cpu = 6 options
    expect(options.length).toBe(6);
    const missingOpt = options[options.length - 2];
    const cpuOpt = options[options.length - 1];

    expect(cpuOpt.value).toBe('cpu');
    expect(missingOpt.value).toBe('missing-card');
    expect(missingOpt.label).toBe('NVIDIA GeForce RTX 3080');
    expect(missingOpt.disabled).toBe(true);
    expect(missingOpt.disabledNote).toBe(DEVICE_COPY.options.missingAdapterNote);
    expect(vm?.selectedValue).toBe('missing-card');
  });

  it('uses fallback label when missing adapter has no stored name', () => {
    const pref: DevicePreferenceRead = {
      ...samplePreference,
      mode: 'adapter',
      adapter_key: 'missing-card-noname',
      adapter_name: null,
      status: 'adapter_missing',
    };
    const vm = service.create(null, pref, false, null);
    const missingOpt = vm?.options.find(
      (opt) => opt.value === 'missing-card-noname',
    );
    expect(missingOpt).toBeDefined();
    expect(missingOpt?.label).toBe(DEVICE_COPY.options.missingAdapterFallback);
    expect(missingOpt?.disabled).toBe(true);
    expect(missingOpt?.disabledNote).toBe(DEVICE_COPY.options.missingAdapterNote);
    expect(vm?.selectedValue).toBe('missing-card-noname');
  });

  it('does not add duplicate option when stored key matches an existing non-selectable choice', () => {
    const pref: DevicePreferenceRead = {
      ...samplePreference,
      mode: 'adapter',
      adapter_key: 'unknown-gpu',
      adapter_name: 'Unknown Graphics Device',
      status: 'adapter_missing',
    };
    const vm = service.create(null, pref, false, null);
    const options = vm?.options ?? [];
    // auto + 3 choices + cpu = 5 (no 6th option added)
    expect(options.length).toBe(5);
    const unknownOpt = options.find((opt) => opt.value === 'unknown-gpu');
    expect(unknownOpt).toBeDefined();
    expect(unknownOpt?.disabled).toBe(true);
    expect(vm?.selectedValue).toBe('unknown-gpu');
  });

  it('selects re-matched choice by unique name without synthetic option when key changed', () => {
    const pref: DevicePreferenceRead = {
      ...samplePreference,
      mode: 'adapter',
      adapter_key: 'old-driver-key',
      adapter_name: 'NVIDIA GeForce RTX 4090',
      status: 'active',
    };
    const vm = service.create(null, pref, false, null);
    const options = vm?.options ?? [];
    // auto + 3 choices + cpu = 5 (no synthetic option)
    expect(options.length).toBe(5);
    expect(options.some((opt) => opt.id === 'stored')).toBe(false);
    expect(vm?.selectedId).toBe('adapter-0');
    expect(vm?.selectedValue).toBe('rtx-4090');
  });

  it('adds synthetic selected option without note when multiple choices share the stored name', () => {
    const pref: DevicePreferenceRead = {
      ...samplePreference,
      mode: 'adapter',
      adapter_key: 'old-driver-key',
      adapter_name: 'NVIDIA GeForce RTX 4090',
      status: 'active',
      choices: [
        {
          adapter_key: 'new-key-1',
          name: 'NVIDIA GeForce RTX 4090',
          classification: 'dedicated',
          backend: 'cuda',
          selectable: true,
        },
        {
          adapter_key: 'new-key-2',
          name: 'NVIDIA GeForce RTX 4090',
          classification: 'dedicated',
          backend: 'cuda',
          selectable: true,
        },
      ],
    };
    const vm = service.create(null, pref, false, null);
    const options = vm?.options ?? [];
    // auto + 2 choices + 1 synthetic + cpu = 5
    expect(options.length).toBe(5);
    const storedOpt = options[options.length - 2];
    expect(storedOpt.id).toBe('stored');
    expect(storedOpt.value).toBe('old-driver-key');
    expect(storedOpt.label).toBe('NVIDIA GeForce RTX 4090');
    expect(storedOpt.disabled).toBe(true);
    expect(storedOpt.disabledNote).toBeNull();
    expect(vm?.selectedId).toBe('stored');
    expect(vm?.selectedValue).toBe('old-driver-key');
  });

  it('adds synthetic selected option without note when no choice matches stored name', () => {
    const pref: DevicePreferenceRead = {
      ...samplePreference,
      mode: 'adapter',
      adapter_key: 'old-driver-key',
      adapter_name: 'Nonexistent Graphics Adapter',
      status: 'active',
    };
    const vm = service.create(null, pref, false, null);
    const options = vm?.options ?? [];
    // auto + 3 choices + 1 synthetic + cpu = 6
    expect(options.length).toBe(6);
    const storedOpt = options[options.length - 2];
    expect(storedOpt.id).toBe('stored');
    expect(storedOpt.value).toBe('old-driver-key');
    expect(storedOpt.label).toBe('Nonexistent Graphics Adapter');
    expect(storedOpt.disabled).toBe(true);
    expect(storedOpt.disabledNote).toBeNull();
    expect(vm?.selectedId).toBe('stored');
    expect(vm?.selectedValue).toBe('old-driver-key');
  });

  it('assigns unique option ids when choices have duplicate keys and selects the first matching choice', () => {
    const pref: DevicePreferenceRead = {
      ...samplePreference,
      mode: 'adapter',
      adapter_key: 'ambiguous-key',
      adapter_name: 'Ambiguous GPU',
      status: 'active',
      choices: [
        {
          adapter_key: 'ambiguous-key',
          name: 'Ambiguous GPU #1',
          classification: 'unknown',
          backend: null,
          selectable: false,
        },
        {
          adapter_key: 'ambiguous-key',
          name: 'Ambiguous GPU #2',
          classification: 'unknown',
          backend: null,
          selectable: false,
        },
      ],
    };
    const vm = service.create(null, pref, false, null);
    const options = vm?.options ?? [];
    const allIds = options.map((opt) => opt.id);
    expect(new Set(allIds).size).toBe(allIds.length);

    expect(options[1].id).toBe('adapter-0');
    expect(options[2].id).toBe('adapter-1');
    expect(options[1].value).toBe('ambiguous-key');
    expect(options[2].value).toBe('ambiguous-key');

    expect(vm?.selectedId).toBe('adapter-0');
    expect(vm?.selectedValue).toBe('ambiguous-key');
  });

  describe('needsAttention', () => {
    it('is true when preference status is pending', () => {
      const pref: DevicePreferenceRead = {
        ...samplePreference,
        status: 'pending',
      };
      const vm = service.create(null, pref, false, null);
      expect(vm?.needsAttention).toBe(true);
    });

    it('is true when preference status is adapter_missing', () => {
      const pref: DevicePreferenceRead = {
        ...samplePreference,
        mode: 'adapter',
        adapter_key: 'missing-card',
        status: 'adapter_missing',
      };
      const vm = service.create(null, pref, false, null);
      expect(vm?.needsAttention).toBe(true);
    });

    it('is true when device verification is mismatch', () => {
      const device: OllamaDeviceRead = {
        server: 'owned',
        requested: {
          target: 'dedicated_gpu',
          backend: 'cuda',
          adapter_name: 'NVIDIA GeForce RTX 4090',
        },
        verification: 'mismatch',
        observed: {
          backend: 'cpu',
          adapter_name: null,
          offloaded_layers: 0,
          total_layers: 32,
        },
        corrective_restarts: 1,
      };
      const vm = service.create(device, samplePreference, false, null);
      expect(vm?.needsAttention).toBe(true);
    });

    it('is true when there is a save error', () => {
      const vm = service.create(null, samplePreference, false, '連線逾時');
      expect(vm?.needsAttention).toBe(true);
    });

    it('is false when preference is active and device is verified without errors', () => {
      const device: OllamaDeviceRead = {
        server: 'owned',
        requested: {
          target: 'dedicated_gpu',
          backend: 'cuda',
          adapter_name: 'NVIDIA GeForce RTX 4090',
        },
        verification: 'verified',
        observed: {
          backend: 'cuda',
          adapter_name: 'NVIDIA GeForce RTX 4090',
          offloaded_layers: 32,
          total_layers: 32,
        },
        corrective_restarts: 0,
      };
      const vm = service.create(device, samplePreference, false, null);
      expect(vm?.needsAttention).toBe(false);
    });

    it('is false for not_applicable and external_server without errors', () => {
      const prefNotApp: DevicePreferenceRead = {
        ...samplePreference,
        status: 'not_applicable',
      };
      const vmNotApp = service.create(null, prefNotApp, false, null);
      expect(vmNotApp?.needsAttention).toBe(false);

      const prefExternal: DevicePreferenceRead = {
        ...samplePreference,
        status: 'external_server',
      };
      const vmExternal = service.create(null, prefExternal, false, null);
      expect(vmExternal?.needsAttention).toBe(false);
    });

    it('is false when device verification is pending on an active preference', () => {
      const device: OllamaDeviceRead = {
        server: 'owned',
        requested: {
          target: 'dedicated_gpu',
          backend: 'cuda',
          adapter_name: 'NVIDIA GeForce RTX 4090',
        },
        verification: 'pending',
        observed: null,
        corrective_restarts: 0,
      };
      const vm = service.create(device, samplePreference, false, null);
      expect(vm?.needsAttention).toBe(false);
    });
  });

  it('handles preference status not_applicable and hides the radio group', () => {
    const pref: DevicePreferenceRead = {
      ...samplePreference,
      status: 'not_applicable',
    };
    const vm = service.create(null, pref, false, null);
    expect(vm?.showChooser).toBe(false);
    expect(vm?.statusLine).toEqual({
      kind: 'not_applicable',
      text: DEVICE_COPY.status.notApplicable,
    });
  });

  it('marks non-selectable choices as disabled with the explanatory note', () => {
    const vm = service.create(null, samplePreference, false, null);
    const nonSelectableOpt = vm?.options.find(
      (opt) => opt.value === 'unknown-gpu',
    );
    expect(nonSelectableOpt).toBeDefined();
    expect(nonSelectableOpt?.disabled).toBe(true);
    expect(nonSelectableOpt?.disabledNote).toBe(
      DEVICE_COPY.options.notSelectableNote,
    );
  });

  it('reflects saving and error states correctly', () => {
    const vm = service.create(null, samplePreference, true, 'Test error');
    expect(vm?.busy).toBe(true);
    expect(vm?.error).toBe('Test error');
  });
});
