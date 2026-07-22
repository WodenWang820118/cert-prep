import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { CAPTURE_ADAPTER, type CaptureAdapter, type CaptureResultV1, type CaptureTaskView, type CaptureWorkbenchConfig } from './capture-contracts';
import { captureAccept, classifyCaptureFile, serializeCaptureResult } from './capture-result';

const DEFAULT_CONFIG = { enabledSources: ['pdf', 'image', 'audio'] as const, outputMode: 'json' as const, multiple: true, languageHint: 'auto', width: '100%', height: 'auto', density: 'comfortable' as const };

@Component({ selector: 'cert-capture-workbench', imports: [], templateUrl: './capture-ui.html', styleUrl: './capture-ui.css', changeDetection: ChangeDetectionStrategy.OnPush })
export class CaptureUi {
  private readonly injectedAdapter = inject(CAPTURE_ADAPTER, { optional: true });
  private readonly controllers = new Map<string, AbortController>();
  readonly config = input<CaptureWorkbenchConfig>({});
  readonly adapter = input<CaptureAdapter | null>(null);
  readonly completed = output<CaptureResultV1>();
  readonly failed = output<{ readonly fileName: string; readonly error: string }>();
  protected readonly tasks = signal<readonly CaptureTaskView[]>([]);
  protected readonly resolvedConfig = computed(() => ({ ...DEFAULT_CONFIG, ...this.config() }));
  protected readonly accept = computed(() => captureAccept(this.resolvedConfig().enabledSources));
  protected readonly hostStyles = computed(() => { const config = this.resolvedConfig(); const colors = this.config().colors; return { '--capture-accent': colors?.accent ?? '#2563eb', '--capture-background': colors?.background ?? '#ffffff', '--capture-foreground': colors?.foreground ?? '#172033', '--capture-border': colors?.border ?? '#cbd5e1', width: config.width, height: config.height }; });

  protected chooseFiles(event: Event): void { const element = event.target as HTMLInputElement; const files = Array.from(element.files ?? []); element.value = ''; for (const file of files) void this.start(file); }
  protected cancel(id: string): void { this.controllers.get(id)?.abort(); this.updateTask(id, { status: 'canceled' }); }
  protected renderedResult(task: CaptureTaskView): string { return task.result ? serializeCaptureResult(task.result, this.resolvedConfig().outputMode) : ''; }
  protected exportResult(task: CaptureTaskView): void { if (!task.result) return; const mode = this.resolvedConfig().outputMode; const blob = new Blob([serializeCaptureResult(task.result, mode)], { type: mode === 'json' ? 'application/json' : 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${task.fileName}.${mode === 'json' ? 'json' : 'txt'}`; anchor.click(); URL.revokeObjectURL(url); }

  private async start(file: File): Promise<void> {
    const sourceKind = classifyCaptureFile(file); const activeAdapter = this.adapter() ?? this.injectedAdapter;
    if (!sourceKind || !this.resolvedConfig().enabledSources.includes(sourceKind)) return this.reject(file, sourceKind ?? 'pdf', `Unsupported capture source: ${file.name}`);
    if (!activeAdapter) return this.reject(file, sourceKind, 'Capture adapter is not configured.');
    const id = crypto.randomUUID(); const controller = new AbortController(); this.controllers.set(id, controller);
    this.tasks.update((tasks) => [...tasks, { id, fileName: file.name, sourceKind, status: 'processing', progress: 0 }]);
    try {
      const result = await activeAdapter.process({ file, sourceKind, languageHint: this.resolvedConfig().languageHint, signal: controller.signal, reportProgress: (progress) => this.updateTask(id, { progress: Math.max(0, Math.min(100, progress)) }) });
      if (controller.signal.aborted) return; this.updateTask(id, { status: 'completed', progress: 100, result }); this.completed.emit(result);
    } catch (error: unknown) {
      if (controller.signal.aborted) return; const message = error instanceof Error ? error.message : 'Capture failed.'; this.updateTask(id, { status: 'failed', error: message }); this.failed.emit({ fileName: file.name, error: message });
    } finally { this.controllers.delete(id); }
  }
  private reject(file: File, sourceKind: CaptureTaskView['sourceKind'], error: string): void { this.tasks.update((tasks) => [...tasks, { id: crypto.randomUUID(), fileName: file.name, sourceKind, status: 'failed', progress: 0, error }]); this.failed.emit({ fileName: file.name, error }); }
  private updateTask(id: string, patch: Partial<CaptureTaskView>): void { this.tasks.update((tasks) => tasks.map((task) => task.id === id ? { ...task, ...patch } : task)); }
}
