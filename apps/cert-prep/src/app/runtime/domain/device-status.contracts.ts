import type {
  DevicePreferenceMode,
  DevicePreferenceUpdate,
} from '@cert-prep/api';

/**
 * Value for the radio group options: 'auto', 'cpu', or an adapter_key string.
 */
type DeviceOptionValue = string;

/**
 * One selectable or disabled option in the device radio group.
 */
export interface DeviceOptionView {
  readonly id: string;
  readonly value: DeviceOptionValue;
  readonly mode: DevicePreferenceMode;
  readonly adapterKey: string | null;
  readonly label: string;
  readonly classificationLabel: string | null;
  readonly backendLabel: string | null;
  readonly disabledNote: string | null;
  readonly disabled: boolean;
}

/**
 * Category of device status line under the chooser group.
 */
type DeviceStatusLineKind =
  | 'verified'
  | 'mismatch'
  | 'pending'
  | 'saved_external'
  | 'adapter_missing'
  | 'not_applicable'
  | 'not_running';

/**
 * Single-line device verification or preference status note.
 */
export interface DeviceStatusLineView {
  readonly kind: DeviceStatusLineKind;
  readonly text: string;
}

/**
 * Persistent external server guidance note.
 */
export interface DeviceExternalNoteView {
  readonly meaning: string;
  readonly action: string;
}

/**
 * Complete view model for the "運算裝置" (Computing Device) section.
 */
export interface DeviceSectionViewModel {
  readonly title: string;
  readonly options: readonly DeviceOptionView[];
  readonly selectedId: string | null;
  readonly selectedValue: DeviceOptionValue | null;
  readonly showChooser: boolean;
  readonly statusLine: DeviceStatusLineView | null;
  readonly externalNote: DeviceExternalNoteView | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly needsAttention: boolean;
}

export type { DevicePreferenceUpdate };
