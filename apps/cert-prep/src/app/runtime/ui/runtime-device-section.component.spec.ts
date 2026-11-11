import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { DevicePreferenceUpdate, DeviceSectionViewModel } from '../domain';
import { RuntimeDeviceSectionComponent } from './runtime-device-section.component';

describe('RuntimeDeviceSectionComponent', () => {
  let fixture: ComponentFixture<RuntimeDeviceSectionComponent>;
  let component: RuntimeDeviceSectionComponent;

  const baseViewModel: DeviceSectionViewModel = {
    title: '運算裝置',
    options: [
      {
        id: 'device-pref-auto',
        value: 'auto',
        mode: 'auto',
        adapterKey: null,
        label: '自動（建議）',
        classificationLabel: null,
        backendLabel: null,
        disabledNote: null,
        disabled: false,
      },
      {
        id: 'device-pref-adapter-nv4090',
        value: 'nv4090',
        mode: 'adapter',
        adapterKey: 'nv4090',
        label: 'NVIDIA GeForce RTX 4090',
        classificationLabel: '獨立顯示卡',
        backendLabel: 'CUDA',
        disabledNote: null,
        disabled: false,
      },
      {
        id: 'device-pref-adapter-unknown',
        value: 'unknown-key',
        mode: 'adapter',
        adapterKey: 'unknown-key',
        label: 'Unknown Graphics Adapter',
        classificationLabel: null,
        backendLabel: null,
        disabledNote: '無法判斷這張顯示卡的類型，不能選擇',
        disabled: true,
      },
      {
        id: 'device-pref-cpu',
        value: 'cpu',
        mode: 'cpu',
        adapterKey: null,
        label: '只用 CPU（較慢）',
        classificationLabel: null,
        backendLabel: null,
        disabledNote: null,
        disabled: false,
      },
    ],
    selectedValue: 'nv4090',
    selectedId: 'device-pref-adapter-nv4090',
    showChooser: true,
    statusLine: {
      kind: 'verified',
      text: '正在使用：NVIDIA GeForce RTX 4090',
    },
    externalNote: null,
    busy: false,
    error: null,
    needsAttention: false,
  };

  function setup(vm: DeviceSectionViewModel = baseViewModel): void {
    TestBed.configureTestingModule({
      imports: [RuntimeDeviceSectionComponent],
    });
    fixture = TestBed.createComponent(RuntimeDeviceSectionComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('viewModel', vm);
    fixture.detectChanges();
  }

  it('renders section title, radio options and checked selection', () => {
    setup();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('h3')?.textContent).toContain('運算裝置');

    const inputs = el.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(inputs.length).toBe(4);

    const checkedInput = el.querySelector<HTMLInputElement>(
      'input[type="radio"]:checked',
    );
    expect(checkedInput?.value).toBe('nv4090');

    expect(el.textContent).toContain('NVIDIA GeForce RTX 4090');
    expect(el.textContent).toContain('獨立顯示卡');
    expect(el.textContent).toContain('CUDA');
    expect(el.textContent).toContain('正在使用：NVIDIA GeForce RTX 4090');
  });

  it('renders disabled option with explanatory note', () => {
    setup();
    const el = fixture.nativeElement as HTMLElement;

    const disabledInput = el.querySelector<HTMLInputElement>(
      'input[value="unknown-key"]',
    );
    expect(disabledInput?.disabled).toBe(true);
    expect(el.textContent).toContain('無法判斷這張顯示卡的類型，不能選擇');
  });

  it('emits choose with { mode: "auto" } when Auto option selected', () => {
    setup();
    let emittedUpdate: DevicePreferenceUpdate | undefined;
    component.choose.subscribe((update) => (emittedUpdate = update));

    const autoRadio = fixture.nativeElement.querySelector(
      'input[value="auto"]',
    ) as HTMLInputElement;
    autoRadio.dispatchEvent(new Event('change'));

    expect(emittedUpdate).toEqual({ mode: 'auto' });
  });

  it('emits choose with { mode: "adapter", adapter_key: "nv4090" } when adapter selected', () => {
    setup({
      ...baseViewModel,
      selectedId: 'device-pref-auto',
      selectedValue: 'auto',
    });
    let emittedUpdate: DevicePreferenceUpdate | undefined;
    component.choose.subscribe((update) => (emittedUpdate = update));

    const adapterRadio = fixture.nativeElement.querySelector(
      'input[value="nv4090"]',
    ) as HTMLInputElement;
    adapterRadio.dispatchEvent(new Event('change'));

    expect(emittedUpdate).toEqual({
      mode: 'adapter',
      adapter_key: 'nv4090',
    });
  });

  it('emits choose with { mode: "cpu" } when CPU option selected', () => {
    setup();
    let emittedUpdate: DevicePreferenceUpdate | undefined;
    component.choose.subscribe((update) => (emittedUpdate = update));

    const cpuRadio = fixture.nativeElement.querySelector(
      'input[value="cpu"]',
    ) as HTMLInputElement;
    cpuRadio.dispatchEvent(new Event('change'));

    expect(emittedUpdate).toEqual({ mode: 'cpu' });
  });

  it('renders persistent external note when present', () => {
    setup({
      ...baseViewModel,
      externalNote: {
        meaning:
          'Ollama 已在別處執行（例如系統匣），Cert Prep 不會更改它，也無法得知它用哪個裝置。',
        action:
          '若要由 Cert Prep 選擇裝置，請從系統匣結束 Ollama，再按「Refresh all」。',
      },
    });

    const el = fixture.nativeElement as HTMLElement;
    const noteEl = el.querySelector('[role="note"]');
    expect(noteEl).not.toBeNull();
    expect(noteEl?.textContent).toContain('Ollama 已在別處執行');
    expect(noteEl?.textContent).toContain('Refresh all');
  });

  it('renders error alert with role="alert" when error is present', () => {
    setup({
      ...baseViewModel,
      error: '無法儲存裝置選擇：連線逾時',
    });

    const el = fixture.nativeElement as HTMLElement;
    const alertEl = el.querySelector('[role="alert"]');
    expect(alertEl).not.toBeNull();
    expect(alertEl?.textContent).toContain('無法儲存裝置選擇：連線逾時');
  });

  it('restores the checked radio when a save fails without changing the selected value', () => {
    setup();
    const el = fixture.nativeElement as HTMLElement;
    const cpu = el.querySelector<HTMLInputElement>('input[value="cpu"]');
    cpu?.click();
    expect(cpu?.checked).toBe(true);
    fixture.componentRef.setInput('viewModel', {
      ...baseViewModel,
      busy: true,
    });
    fixture.detectChanges();
    fixture.componentRef.setInput('viewModel', {
      ...baseViewModel,
      error: '儲存失敗',
    });
    fixture.detectChanges();
    expect(cpu?.checked).toBe(false);
    expect(
      el.querySelector<HTMLInputElement>('input[value="nv4090"]')?.checked,
    ).toBe(true);
  });

  it('labels the group and each input, announces status and disables all choices while busy', () => {
    setup({ ...baseViewModel, busy: true });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('legend')?.textContent).toContain('選擇運算裝置');
    expect(el.querySelector<HTMLFieldSetElement>('fieldset')?.disabled).toBe(
      true,
    );
    expect(el.querySelector('[aria-live="polite"]')?.textContent).toContain(
      '正在使用',
    );
    for (const input of el.querySelectorAll<HTMLInputElement>('input')) {
      expect(input.disabled).toBe(true);
      expect(input.labels?.length).toBe(1);
    }
    const choose = vi.fn();
    component.choose.subscribe(choose);
    el.querySelector('input')?.dispatchEvent(new Event('change'));
    expect(choose).not.toHaveBeenCalled();
  });

  it('gives simultaneous route and modal sections separate radio groups and labels', () => {
    setup();
    const other = TestBed.createComponent(RuntimeDeviceSectionComponent);
    other.componentRef.setInput('viewModel', baseViewModel);
    other.detectChanges();
    const firstInput = fixture.nativeElement.querySelector(
      'input',
    ) as HTMLInputElement;
    const otherInput = other.nativeElement.querySelector(
      'input',
    ) as HTMLInputElement;
    expect(firstInput.name).not.toBe(otherInput.name);
    expect(firstInput.id).not.toBe(otherInput.id);
  });

  it('visually hides the section title while keeping it for accessibility labeling', () => {
    setup();
    const el = fixture.nativeElement as HTMLElement;
    const h3 = el.querySelector('h3');
    expect(h3).not.toBeNull();
    expect(h3?.textContent).toContain('運算裝置');
    expect(h3?.classList.contains('sr-only')).toBe(true);
    const section = el.querySelector('section');
    expect(section?.getAttribute('aria-labelledby')).toBe(h3?.id);
  });

  it('renders a missing adapter option as checked and disabled with its note', () => {
    const missingOptionVm: DeviceSectionViewModel = {
      ...baseViewModel,
      options: [
        baseViewModel.options[0],
        baseViewModel.options[1],
        {
          id: 'device-pref-adapter-missing-gpu',
          value: 'missing-gpu',
          mode: 'adapter',
          adapterKey: 'missing-gpu',
          label: 'NVIDIA GeForce RTX 3080',
          classificationLabel: null,
          backendLabel: null,
          disabledNote: '目前找不到這張顯示卡',
          disabled: true,
        },
        baseViewModel.options[3],
      ],
      selectedValue: 'missing-gpu',
      selectedId: 'device-pref-adapter-missing-gpu',
      statusLine: {
        kind: 'adapter_missing',
        text: '找不到選擇的顯示卡，暫用自動選擇',
      },
    };
    setup(missingOptionVm);
    const el = fixture.nativeElement as HTMLElement;
    const missingInput = el.querySelector<HTMLInputElement>(
      'input[value="missing-gpu"]',
    );
    expect(missingInput).not.toBeNull();
    expect(missingInput?.checked).toBe(true);
    expect(missingInput?.disabled).toBe(true);
    expect(el.textContent).toContain('NVIDIA GeForce RTX 3080');
    expect(el.textContent).toContain('目前找不到這張顯示卡');
    expect(el.textContent).toContain('找不到選擇的顯示卡，暫用自動選擇');
  });

  it('renders two options with the same value with different input ids, labels bound to their own input, one checked', () => {
    const duplicateOptionsVm: DeviceSectionViewModel = {
      ...baseViewModel,
      options: [
        {
          id: 'adapter-0',
          value: 'duplicate-key',
          mode: 'adapter',
          adapterKey: 'duplicate-key',
          label: 'Ambiguous GPU #1',
          classificationLabel: null,
          backendLabel: null,
          disabledNote: '無法判斷這張顯示卡的類型，不能選擇',
          disabled: true,
        },
        {
          id: 'adapter-1',
          value: 'duplicate-key',
          mode: 'adapter',
          adapterKey: 'duplicate-key',
          label: 'Ambiguous GPU #2',
          classificationLabel: null,
          backendLabel: null,
          disabledNote: '無法判斷這張顯示卡的類型，不能選擇',
          disabled: true,
        },
      ],
      selectedId: 'adapter-0',
      selectedValue: 'duplicate-key',
    };
    setup(duplicateOptionsVm);
    const el = fixture.nativeElement as HTMLElement;
    const inputs = el.querySelectorAll<HTMLInputElement>(
      'input[value="duplicate-key"]',
    );
    expect(inputs.length).toBe(2);
    expect(inputs[0].id).not.toBe(inputs[1].id);

    const labels = el.querySelectorAll<HTMLLabelElement>(
      'label.runtime-device-option',
    );
    expect(labels[0].getAttribute('for')).toBe(inputs[0].id);
    expect(labels[1].getAttribute('for')).toBe(inputs[1].id);

    expect(inputs[0].checked).toBe(true);
    expect(inputs[1].checked).toBe(false);
  });
});
