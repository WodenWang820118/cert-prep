import { Injectable } from '@angular/core';
import type {
  DeviceBackend,
  DeviceChoiceRead,
  DevicePreferenceRead,
  ObservedDeviceRead,
  OllamaDeviceRead,
  RequestedDeviceRead,
} from '@cert-prep/api';
import {
  DEVICE_COPY,
  type DeviceExternalNoteView,
  type DeviceOptionView,
  type DeviceSectionViewModel,
  type DeviceStatusLineView,
} from '../domain';

function formatBackend(
  backend: DeviceBackend | string | null | undefined,
): string | null {
  if (!backend) {
    return null;
  }
  const lower = backend.trim().toLowerCase();
  if (lower === 'cuda') return 'CUDA';
  if (lower === 'vulkan') return 'Vulkan';
  if (lower === 'rocm') return 'ROCm';
  if (lower === 'cpu') return 'CPU';
  return backend.trim();
}

function formatRequested(
  requested: RequestedDeviceRead | null | undefined,
): string {
  if (!requested) {
    return '自動';
  }
  if (requested.target === 'cpu') {
    return 'CPU';
  }
  if (requested.adapter_name && requested.adapter_name.trim().length > 0) {
    return requested.adapter_name.trim();
  }
  const backend = formatBackend(requested.backend);
  if (backend) {
    return backend;
  }
  return '自動';
}

function formatObserved(
  observed: ObservedDeviceRead | null | undefined,
): string {
  if (!observed) {
    return 'CPU';
  }
  if (observed.adapter_name && observed.adapter_name.trim().length > 0) {
    return observed.adapter_name.trim();
  }
  const backend = formatBackend(observed.backend);
  if (backend) {
    return backend;
  }
  return 'CPU';
}

function formatVerified(device: OllamaDeviceRead): string {
  const reqTarget = device.requested?.target;
  const obsBackend = device.observed?.backend?.toLowerCase();
  if (reqTarget === 'cpu' || obsBackend === 'cpu') {
    return DEVICE_COPY.status.cpuVerified;
  }
  const name =
    device.observed?.adapter_name?.trim() ||
    device.requested?.adapter_name?.trim() ||
    formatBackend(device.observed?.backend) ||
    'GPU';
  return DEVICE_COPY.status.verified(name);
}

@Injectable({ providedIn: 'root' })
export class DeviceViewModelService {
  create(
    device: OllamaDeviceRead | null,
    preference: DevicePreferenceRead | null,
    saving: boolean,
    error: string | null,
  ): DeviceSectionViewModel | null {
    if (device === null && preference === null) {
      return null;
    }

    const showChooser =
      preference !== null && preference.status !== 'not_applicable';
    const resolution =
      preference === null ? null : this.resolveOptionsAndSelection(preference);
    const options = resolution?.options ?? [];
    const selectedId = resolution?.selectedId ?? null;
    const selectedValue = resolution?.selectedValue ?? null;
    const statusLine = this.buildStatusLine(device, preference);
    const externalNote =
      preference === null ? null : this.buildExternalNote(device, preference);

    const needsAttention =
      Boolean(error) ||
      preference?.status === 'pending' ||
      preference?.status === 'adapter_missing' ||
      device?.verification === 'mismatch';

    return {
      title: DEVICE_COPY.sectionTitle,
      options,
      selectedId,
      selectedValue,
      showChooser,
      statusLine,
      externalNote,
      busy: saving,
      error,
      needsAttention,
    };
  }

  private resolveOptionsAndSelection(
    preference: DevicePreferenceRead,
  ): {
    options: readonly DeviceOptionView[];
    selectedId: string;
    selectedValue: string;
  } {
    const autoOption: DeviceOptionView = {
      id: 'auto',
      value: 'auto',
      mode: 'auto',
      adapterKey: null,
      label: DEVICE_COPY.options.auto,
      classificationLabel: null,
      backendLabel: null,
      disabledNote: null,
      disabled: false,
    };

    const choices = preference.choices ?? [];
    const adapterOptions: DeviceOptionView[] = choices.map(
      (choice: DeviceChoiceRead, index: number) => {
        const classificationLabel =
          choice.classification === 'dedicated'
            ? DEVICE_COPY.options.dedicated
            : choice.classification === 'integrated'
              ? DEVICE_COPY.options.integrated
              : null;

        const backendLabel = formatBackend(choice.backend);
        const disabledNote = choice.selectable
          ? null
          : DEVICE_COPY.options.notSelectableNote;

        return {
          id: `adapter-${index}`,
          value: choice.adapter_key ?? `choice-${index}`,
          mode: 'adapter',
          adapterKey: choice.adapter_key ?? null,
          label: choice.name,
          classificationLabel,
          backendLabel,
          disabledNote,
          disabled: !choice.selectable,
        };
      },
    );

    const { syntheticOption, matchedChoiceIndex } =
      this.resolveAdapterMatch(preference, choices);

    const cpuOption: DeviceOptionView = {
      id: 'cpu',
      value: 'cpu',
      mode: 'cpu',
      adapterKey: null,
      label: DEVICE_COPY.options.cpu,
      classificationLabel: null,
      backendLabel: null,
      disabledNote: null,
      disabled: false,
    };

    const options: DeviceOptionView[] = [
      autoOption,
      ...adapterOptions,
      ...(syntheticOption ? [syntheticOption] : []),
      cpuOption,
    ];

    let selectedId = 'auto';
    let selectedValue = 'auto';

    if (preference.mode === 'cpu') {
      selectedId = 'cpu';
      selectedValue = 'cpu';
    } else if (preference.mode === 'adapter') {
      if (syntheticOption !== null) {
        selectedId = syntheticOption.id;
        selectedValue = syntheticOption.value;
      } else if (matchedChoiceIndex !== null) {
        selectedId = `adapter-${matchedChoiceIndex}`;
        selectedValue = choices[matchedChoiceIndex]?.adapter_key ?? 'auto';
      }
    }

    return { options, selectedId, selectedValue };
  }

  private resolveAdapterMatch(
    preference: DevicePreferenceRead,
    choices: readonly DeviceChoiceRead[],
  ): {
    syntheticOption: DeviceOptionView | null;
    matchedChoiceIndex: number | null;
  } {
    if (preference.mode !== 'adapter') {
      return { syntheticOption: null, matchedChoiceIndex: null };
    }

    const keyIndex = choices.findIndex(
      (c) => c.adapter_key === preference.adapter_key,
    );

    if (keyIndex !== -1) {
      return { syntheticOption: null, matchedChoiceIndex: keyIndex };
    }

    // Stored key matches no choice
    if (preference.status === 'adapter_missing') {
      const label =
        preference.adapter_name && preference.adapter_name.trim().length > 0
          ? preference.adapter_name.trim()
          : DEVICE_COPY.options.missingAdapterFallback;

      const syntheticOption: DeviceOptionView = {
        id: 'stored',
        value: preference.adapter_key ?? 'stored',
        mode: 'adapter',
        adapterKey: preference.adapter_key ?? null,
        label,
        classificationLabel: null,
        backendLabel: null,
        disabledNote: DEVICE_COPY.options.missingAdapterNote,
        disabled: true,
      };

      return { syntheticOption, matchedChoiceIndex: null };
    }

    // Status is not adapter_missing: re-match by unique selectable name
    const selectableNameMatches = choices
      .map((choice, index) => ({ choice, index }))
      .filter(
        ({ choice }) =>
          choice.selectable && choice.name === preference.adapter_name,
      );

    if (selectableNameMatches.length === 1) {
      return {
        syntheticOption: null,
        matchedChoiceIndex: selectableNameMatches[0].index,
      };
    }

    // 0 or >= 2 name matches: add synthetic option without note
    const label =
      preference.adapter_name && preference.adapter_name.trim().length > 0
        ? preference.adapter_name.trim()
        : DEVICE_COPY.options.missingAdapterFallback;

    const syntheticOption: DeviceOptionView = {
      id: 'stored',
      value: preference.adapter_key ?? 'stored',
      mode: 'adapter',
      adapterKey: preference.adapter_key ?? null,
      label,
      classificationLabel: null,
      backendLabel: null,
      disabledNote: null,
      disabled: true,
    };

    return { syntheticOption, matchedChoiceIndex: null };
  }

  private buildStatusLine(
    device: OllamaDeviceRead | null,
    preference: DevicePreferenceRead | null,
  ): DeviceStatusLineView | null {
    if (preference?.status === 'not_applicable') {
      return {
        kind: 'not_applicable',
        text: DEVICE_COPY.status.notApplicable,
      };
    }

    if (preference?.status === 'adapter_missing') {
      return {
        kind: 'adapter_missing',
        text: DEVICE_COPY.status.adapterMissing,
      };
    }

    if (preference?.status === 'pending') {
      return {
        kind: 'pending',
        text: DEVICE_COPY.status.pendingSwitch,
      };
    }

    if (preference?.status === 'external_server') {
      return {
        kind: 'saved_external',
        text: DEVICE_COPY.status.savedWhileExternal,
      };
    }

    if (device?.server === 'not_running') {
      return {
        kind: 'not_running',
        text: DEVICE_COPY.status.serverNotRunning,
      };
    }

    if (device) {
      if (device.verification === 'mismatch') {
        return {
          kind: 'mismatch',
          text: DEVICE_COPY.status.mismatch(
            formatRequested(device.requested),
            formatObserved(device.observed),
          ),
        };
      }

      if (device.verification === 'verified') {
        return {
          kind: 'verified',
          text: formatVerified(device),
        };
      }

      if (
        device.verification === 'pending' ||
        device.verification === 'unknown'
      ) {
        return {
          kind: 'pending',
          text: DEVICE_COPY.status.pendingVerification,
        };
      }
    }

    return null;
  }

  private buildExternalNote(
    device: OllamaDeviceRead | null,
    preference: DevicePreferenceRead | null,
  ): DeviceExternalNoteView | null {
    if (
      device?.server === 'external' ||
      preference?.status === 'external_server'
    ) {
      return {
        meaning: DEVICE_COPY.external.meaning,
        action: DEVICE_COPY.external.action,
      };
    }
    return null;
  }
}
