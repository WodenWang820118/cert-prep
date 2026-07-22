import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CaptureUi } from './capture-ui';
import type { CaptureAdapter, CaptureResultV1 } from './capture-contracts';

describe('CaptureUi', () => {
  let fixture: ComponentFixture<CaptureUi>;
  beforeEach(async () => { await TestBed.configureTestingModule({ imports: [CaptureUi] }).compileComponents(); fixture = TestBed.createComponent(CaptureUi); });

  it('applies host colors, dimensions, and source filters', () => {
    fixture.componentRef.setInput('config', { width: '32rem', height: '24rem', colors: { accent: '#7c3aed' }, enabledSources: ['image'] }); fixture.detectChanges();
    const panel = fixture.nativeElement.querySelector('.capture-workbench') as HTMLElement;
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    expect(panel.style.width).toBe('32rem'); expect(panel.style.height).toBe('24rem'); expect(panel.style.getPropertyValue('--capture-accent')).toBe('#7c3aed'); expect(input.accept).toContain('.png'); expect(input.accept).not.toContain('.pdf');
  });

  it('processes a selected file through the adapter and emits canonical output', async () => {
    const output: CaptureResultV1 = { schemaVersion: '1.0', source: { fileName: 'scan.pdf', mediaType: 'application/pdf', kind: 'pdf', sizeBytes: 4 }, status: 'completed', text: 'page one', pages: [{ pageNumber: 1, text: 'page one' }], engine: { name: 'test-ocr' }, startedAt: '2026-07-20T00:00:00Z', completedAt: '2026-07-20T00:00:01Z' };
    const adapter: CaptureAdapter = { process: vi.fn(async ({ reportProgress }) => { reportProgress(50); return output; }) };
    const emitted = vi.fn(); fixture.componentRef.setInput('adapter', adapter); fixture.componentInstance.completed.subscribe(emitted); fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement; Object.defineProperty(input, 'files', { value: [new File(['test'], 'scan.pdf', { type: 'application/pdf' })], configurable: true }); input.dispatchEvent(new Event('change')); await fixture.whenStable(); fixture.detectChanges();
    expect(adapter.process).toHaveBeenCalledOnce(); expect(emitted).toHaveBeenCalledWith(output); expect(fixture.nativeElement.textContent).toContain('page one');
  });

  it('reports missing adapter as a per-file failure', async () => {
    const failed = vi.fn(); fixture.componentInstance.failed.subscribe(failed); fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement; Object.defineProperty(input, 'files', { value: [new File(['x'], 'voice.wav')], configurable: true }); input.dispatchEvent(new Event('change')); await fixture.whenStable(); fixture.detectChanges();
    expect(failed).toHaveBeenCalledWith({ fileName: 'voice.wav', error: 'Capture adapter is not configured.' }); expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('not configured');
  });
});
