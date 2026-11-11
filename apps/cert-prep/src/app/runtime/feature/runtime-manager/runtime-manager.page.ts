import {
  Component,
  EventEmitter,
  Input,
  afterNextRender,
  Output,
  computed,
  inject,
  ChangeDetectionStrategy,
  DestroyRef,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { DevicePreferenceUpdate } from '@cert-prep/api';
import {
  DesktopRuntimeStore,
  DevicePreferenceStore,
  DeviceViewModelService,
  HealthStore,
  ModelHealthViewModelFacade,
} from '../../data';
import { DEVICE_COPY } from '../../domain';
import {
  RuntimeDeviceSectionComponent,
  RuntimeStatusRowComponent,
} from '../../ui';
import { OperationStore } from '../../../core/data';
import { ActionButtonComponent } from '../../../core/ui';
import { AppIconComponent } from '../../../core/ui';
import { HlmProgressImports } from '@spartan-ng/helm/progress';
import { HlmTabsImports } from '@spartan-ng/helm/tabs';

@Component({
  selector: 'app-runtime-manager-page',
  imports: [
    NgTemplateOutlet,
    RuntimeStatusRowComponent,
    RuntimeDeviceSectionComponent,
    ActionButtonComponent,
    AppIconComponent,
    HlmProgressImports,
    HlmTabsImports,
  ],
  templateUrl: './runtime-manager.page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './runtime-manager.page.css',
})
export class RuntimeManagerPage {
  private static nextInstanceId = 0;
  protected readonly instanceId = `runtime-manager-${RuntimeManagerPage.nextInstanceId++}`;
  protected readonly runtimeTabKey = `${this.instanceId}-runtime`;
  protected readonly deviceTabKey = `${this.instanceId}-device`;

  @Input() modal = false;
  @Input() titleId = 'runtime-manager-route-title';
  @Output() readonly closeRequested = new EventEmitter<void>();

  protected readonly copy = DEVICE_COPY;
  protected readonly selectedTab = signal<string>(this.runtimeTabKey);

  protected readonly desktopRuntime = inject(DesktopRuntimeStore);
  protected readonly health = inject(HealthStore);
  protected readonly operations = inject(OperationStore);
  protected readonly devicePreference = inject(DevicePreferenceStore);
  private readonly deviceViewModels = inject(DeviceViewModelService);
  private readonly healthViewModels = inject(ModelHealthViewModelFacade);

  protected readonly viewModel = this.healthViewModels.viewModel;

  protected readonly deviceViewModel = computed(() =>
    this.deviceViewModels.create(
      this.health.llmHealth()?.device ?? null,
      this.devicePreference.preference(),
      this.devicePreference.saving(),
      this.devicePreference.error(),
    ),
  );

  // The store counts its consumers, so this instance opens it at most once and
  // closes it only if it opened it (a screen can be destroyed before its first render).
  private preferenceUse: 'idle' | 'open' | 'closed' = 'idle';

  constructor() {
    afterNextRender(() => {
      if (this.preferenceUse === 'idle') {
        this.preferenceUse = 'open';
        this.devicePreference.open();
      }
    });
    inject(DestroyRef).onDestroy(() => this.closePreference());
  }

  private closePreference(): void {
    if (this.preferenceUse === 'open') this.devicePreference.close();
    this.preferenceUse = 'closed';
  }

  protected readonly modelDownloadActionLabel = computed(() =>
    this.health.modelDownload()?.phase === 'failed'
      ? `Retry ${this.health.configuredModelName()}`
      : `Download ${this.health.configuredModelName()}`,
  );

  protected readonly hasLlmRuntimeInstallation = computed(() => {
    const kind = this.health.runtimeInstall()?.kind;
    return kind === 'ollama';
  });

  protected chooseDevice(update: DevicePreferenceUpdate): void {
    this.devicePreference.choose(update);
  }

  protected refreshAll(): void {
    if (this.desktopRuntime.isBackendReady()) {
      this.health.refresh();
      return;
    }
    this.desktopRuntime.load().subscribe();
  }

  protected close(): void {
    if (this.modal) {
      this.closePreference();
      this.closeRequested.emit();
    }
  }
}
