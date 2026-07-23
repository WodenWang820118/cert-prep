import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, runInInjectionContext, signal, Injector, type ResourceRef } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { defer } from 'rxjs';
import { CAPTURE_ADAPTER, type CaptureAdapter, type CaptureResultV1, type CaptureTaskView, type CaptureWorkbenchConfig } from './capture-contracts';
import { captureAccept, classifyCaptureFile, serializeCaptureResult } from './capture-result';

const DEFAULT_CONFIG = { enabledSources: ['pdf', 'image', 'audio'] as const, outputMode: 'json' as const, multiple: true, languageHint: 'auto', width: '100%', height: 'auto', density: 'comfortable' as const };

@Component({ selector: 'cert-capture-workbench', imports: [], templateUrl: './capture-ui.html', styleUrl: './capture-ui.css', changeDetection: ChangeDetectionStrategy.OnPush })
export class CaptureUi {
  private readonly injectedAdapter = inject(CAPTURE_ADAPTER, { optional: true });
  private readonly injector = inject(Injector);
  private readonly resources = new Map<string, ResourceRef<CaptureResultV1 | null>>();
  private readonly resourceEffects = new Map<string, { destroy: () => void }>();
  readonly config = input<CaptureWorkbenchConfig>({});
  readonly adapter = input<CaptureAdapter | null>(null);
  readonly completed = output<CaptureResultV1>();
  readonly failed = output<{ readonly fileName: string; readonly error: string }>();
  protected readonly tasks = signal<readonly CaptureTaskView[]>([]);
  protected readonly resolvedConfig = computed(() => ({ ...DEFAULT_CONFIG, ...this.config() }));
  protected readonly accept = computed(() => captureAccept(this.resolvedConfig().enabledSources));
  protected readonly hostStyles = computed(() => { const config = this.resolvedConfig(); const colors = this.config().colors; return { '--capture-accent': colors?.accent ?? '#2563eb', '--capture-background': colors?.background ?? '#ffffff', '--capture-foreground': colors?.foreground ?? '#172033', '--capture-border': colors?.border ?? '#cbd5e1', width: config.width, height: config.height }; });

  protected chooseFiles(event: Event): void { const element = event.target as HTMLInputElement; const files = Array.from(element.files ?? []); element.value = ''; for (const file of files) this.start(file); }
  protected cancel(id: string): void { this.resources.get(id)?.destroy(); this.resources.delete(id); this.resourceEffects.get(id)?.destroy(); this.resourceEffects.delete(id); this.updateTask(id, { status: 'canceled' }); }
  protected renderedResult(task: CaptureTaskView): string { return task.result ? serializeCaptureResult(task.result, this.resolvedConfig().outputMode) : ''; }
  protected exportResult(task: CaptureTaskView): void { if (!task.result) return; const mode = this.resolvedConfig().outputMode; const blob = new Blob([serializeCaptureResult(task.result, mode)], { type: mode === 'json' ? 'application/json' : 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${task.fileName}.${mode === 'json' ? 'json' : 'txt'}`; anchor.click(); URL.revokeObjectURL(url); }

  private start(file: File): void {
    const sourceKind = classifyCaptureFile(file); const activeAdapter = this.adapter() ?? this.injectedAdapter;
    if (!sourceKind || !this.resolvedConfig().enabledSources.includes(sourceKind)) return this.reject(file, sourceKind ?? 'pdf', `Unsupported capture source: ${file.name}`);
    if (!activeAdapter) return this.reject(file, sourceKind, 'Capture adapter is not configured.');
    const id = crypto.randomUUID();
    this.tasks.update((tasks) => [...tasks, { id, fileName: file.name, sourceKind, status: 'processing', progress: 0 }]);
    const resource = runInInjectionContext(this.injector, () => {
      const started = signal(false);
      const created = rxResource<CaptureResultV1 | null, File | undefined>({
        params: () => (started() ? file : undefined),
        defaultValue: null,
      stream: ({ abortSignal }) => defer(() => activeAdapter.process({ file, sourceKind, languageHint: this.resolvedConfig().languageHint, signal: abortSignal, reportProgress: (progress) => queueMicrotask(() => this.updateTask(id, { progress: Math.max(0, Math.min(100, progress)) })) })),
      });
      started.set(true);
      return created;
    });
    this.resources.set(id, resource);
    this.resourceEffects.set(id, runInInjectionContext(this.injector, () => effect(() => {
      if (!this.resources.has(id)) return;
      if (resource.status() === 'resolved' || resource.status() === 'local') {
        const result = resource.value();
        if (result === null) return;
        this.updateTask(id, { status: 'completed', progress: 100, result });
        this.completed.emit(result);
        this.cleanupTask(id);
      } else if (resource.status() === 'error') {
        const error = resource.error();
        const message = error instanceof Error ? error.message : 'Capture failed.';
        this.updateTask(id, { status: 'failed', error: message });
        this.failed.emit({ fileName: file.name, error: message });
        this.cleanupTask(id);
      }
    })));
  }
  private cleanupTask(id: string): void { this.resourceEffects.get(id)?.destroy(); this.resourceEffects.delete(id); this.resources.get(id)?.destroy(); this.resources.delete(id); }
  private reject(file: File, sourceKind: CaptureTaskView['sourceKind'], error: string): void { this.tasks.update((tasks) => [...tasks, { id: crypto.randomUUID(), fileName: file.name, sourceKind, status: 'failed', progress: 0, error }]); this.failed.emit({ fileName: file.name, error }); }
  private updateTask(id: string, patch: Partial<CaptureTaskView>): void { this.tasks.update((tasks) => tasks.map((task) => task.id === id ? { ...task, ...patch } : task)); }
}
