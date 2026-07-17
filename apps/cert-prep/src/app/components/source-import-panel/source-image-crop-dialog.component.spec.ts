import { TestBed } from '@angular/core/testing';
import { SourceImageCropDialogComponent } from './source-image-crop-dialog.component';
import { SourceImageCropService } from './source-image-crop.service';

describe('SourceImageCropDialogComponent', () => {
  const cropService = {
    crop: vi.fn(),
  };
  let objectUrlCounter = 0;

  beforeEach(async () => {
    vi.clearAllMocks();
    objectUrlCounter = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(
      () => `blob:crop-preview-${++objectUrlCounter}`,
    );
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    await TestBed.configureTestingModule({
      imports: [SourceImageCropDialogComponent],
      providers: [{ provide: SourceImageCropService, useValue: cropService }],
    }).compileComponents();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a named crop dialog with exact keyboard-operable bounds', async () => {
    const fixture = createCropFixture(
      new File(['png'], 'capture.png', { type: 'image/png' }),
    );

    loadFixtureImage(fixture, 12, 8);
    await fixture.whenStable();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('Crop image: capture.png');
    expect(root.textContent).toContain('Image 1 of 2');
    expect(root.textContent).toContain('12 × 8 px');
    for (const label of [
      'Crop left',
      'Crop top',
      'Crop width',
      'Crop height',
    ]) {
      expect(root.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
    }
    expect(inputValue(root, 'Crop left')).toBe('0');
    expect(inputValue(root, 'Crop top')).toBe('0');
    expect(inputValue(root, 'Crop width')).toBe('12');
    expect(inputValue(root, 'Crop height')).toBe('8');
    componentActions(fixture.componentInstance).updateCropField('width', null);
    expect(componentActions(fixture.componentInstance).cropRect().width).toBe(
      12,
    );
    expect(button(root, 'Apply crop')?.disabled).toBe(true);
    expect(button(root, 'Keep original')?.disabled).toBe(false);
  });

  it('applies a narrowed crop and emits the encoded file', async () => {
    const source = new File(['png'], 'capture.png', { type: 'image/png' });
    const cropped = new File(['cropped'], 'capture-cropped.png', {
      type: 'image/png',
    });
    cropService.crop.mockResolvedValue(cropped);
    const fixture = createCropFixture(source);
    loadFixtureImage(fixture, 12, 8);
    const emitted = vi.fn();
    fixture.componentInstance.cropApplied.subscribe(emitted);
    const component = componentActions(fixture.componentInstance);

    component.updateCropField('x', 2);
    component.updateCropField('y', 1);
    component.updateCropField('width', 6);
    component.updateCropField('height', 4);
    fixture.detectChanges();
    expect(button(fixture.nativeElement, 'Apply crop')?.disabled).toBe(false);

    await component.applyCrop();

    expect(cropService.crop).toHaveBeenCalledWith(
      source,
      expect.any(HTMLImageElement),
      { x: 2, y: 1, width: 6, height: 4 },
    );
    expect(emitted).toHaveBeenCalledWith(cropped);
  });

  it('includes the bottom-right image edges in a full-surface pointer drag', () => {
    const fixture = createCropFixture(
      new File(['png'], 'capture.png', { type: 'image/png' }),
    );
    loadFixtureImage(fixture, 12, 8);
    const surface = fixture.nativeElement.querySelector(
      '.crop-surface',
    ) as HTMLElement;
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
      bottom: 100,
      height: 80,
      left: 10,
      right: 130,
      top: 20,
      width: 120,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    });
    const component = componentActions(fixture.componentInstance);

    component.startCropSelection(pointerEvent(10, 20, 7));
    component.finishCropSelection(pointerEvent(130, 100, 7));

    expect(component.cropRect()).toEqual({ x: 0, y: 0, width: 12, height: 8 });

    component.startCropSelection(pointerEvent(130, 100, 8));
    component.finishCropSelection(pointerEvent(10, 20, 8));

    expect(component.cropRect()).toEqual({ x: 0, y: 0, width: 12, height: 8 });
  });

  it('normalizes blank and out-of-range numeric text when an input blurs', () => {
    const fixture = createCropFixture(
      new File(['png'], 'capture.png', { type: 'image/png' }),
    );
    loadFixtureImage(fixture, 12, 8);
    const widthInput = fixture.nativeElement.querySelector(
      '[aria-label="Crop width"]',
    ) as HTMLInputElement;

    widthInput.value = '';
    widthInput.dispatchEvent(new Event('input'));
    expect(componentActions(fixture.componentInstance).cropRect().width).toBe(
      12,
    );
    expect(widthInput.value).toBe('');

    widthInput.dispatchEvent(new Event('blur'));
    expect(widthInput.value).toBe('12');

    widthInput.value = '99';
    widthInput.dispatchEvent(new Event('input'));
    expect(componentActions(fixture.componentInstance).cropRect().width).toBe(
      12,
    );
    expect(widthInput.value).toBe('99');

    widthInput.dispatchEvent(new Event('blur'));
    expect(widthInput.value).toBe('12');
  });

  it('keeps the original available when the preview cannot load', () => {
    const fixture = createCropFixture(
      new File(['broken'], 'capture.png', { type: 'image/png' }),
    );
    const kept = vi.fn();
    fixture.componentInstance.originalKept.subscribe(kept);
    const component = componentActions(fixture.componentInstance);

    component.failImageLoad();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'could not be previewed',
    );
    component.keepOriginal();
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it('revokes every preview URL when the source changes or is destroyed', () => {
    const fixture = createCropFixture(
      new File(['first'], 'first.png', { type: 'image/png' }),
    );
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);

    fixture.componentRef.setInput(
      'sourceFile',
      new File(['second'], 'second.png', { type: 'image/png' }),
    );
    fixture.detectChanges();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:crop-preview-1');

    fixture.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:crop-preview-2');
  });

  it('surfaces an encoder failure without terminating the crop review', async () => {
    const encoder = deferred<File>();
    cropService.crop.mockReturnValue(encoder.promise);
    const fixture = createCropFixture(
      new File(['png'], 'capture.png', { type: 'image/png' }),
    );
    loadFixtureImage(fixture, 12, 8);
    const component = componentActions(fixture.componentInstance);
    component.updateCropField('width', 6);
    fixture.detectChanges();
    const applyButton = button(fixture.nativeElement, 'Apply crop');
    applyButton?.focus();

    const applyResult = component.applyCrop();
    fixture.detectChanges();
    component.startCropSelection(pointerEvent(0, 0, 9));

    expect(component.cropRect().width).toBe(6);
    expect(applyButton?.disabled).toBe(true);

    encoder.reject(new Error('Encoder failed.'));
    await applyResult;
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Encoder failed.');
    expect(button(fixture.nativeElement, 'Keep original')?.disabled).toBe(
      false,
    );
    expect(document.activeElement).toBe(
      fixture.nativeElement.querySelector('[aria-label="Crop review status"]'),
    );
  });
});

function createCropFixture(file: File) {
  const fixture = TestBed.createComponent(SourceImageCropDialogComponent);
  fixture.componentRef.setInput('sourceFile', file);
  fixture.componentRef.setInput('position', 1);
  fixture.componentRef.setInput('total', 2);
  fixture.detectChanges();
  return fixture;
}

function loadFixtureImage(
  fixture: ReturnType<typeof createCropFixture>,
  width: number,
  height: number,
): void {
  const image = fixture.nativeElement.querySelector('img') as HTMLImageElement;
  Object.defineProperty(image, 'naturalWidth', {
    configurable: true,
    value: width,
  });
  Object.defineProperty(image, 'naturalHeight', {
    configurable: true,
    value: height,
  });
  image.dispatchEvent(new Event('load'));
  fixture.detectChanges();
}

function componentActions(component: SourceImageCropDialogComponent): {
  applyCrop(): Promise<void>;
  failImageLoad(): void;
  keepOriginal(): void;
  updateCropField(
    field: 'x' | 'y' | 'width' | 'height',
    value: number | string | null,
  ): void;
  cropRect(): { x: number; y: number; width: number; height: number };
  startCropSelection(event: PointerEvent): void;
  finishCropSelection(event: PointerEvent): void;
} {
  return component as unknown as {
    applyCrop(): Promise<void>;
    failImageLoad(): void;
    keepOriginal(): void;
    updateCropField(
      field: 'x' | 'y' | 'width' | 'height',
      value: number | string | null,
    ): void;
    cropRect(): { x: number; y: number; width: number; height: number };
    startCropSelection(event: PointerEvent): void;
    finishCropSelection(event: PointerEvent): void;
  };
}

function pointerEvent(
  clientX: number,
  clientY: number,
  pointerId: number,
): PointerEvent {
  return {
    button: 0,
    clientX,
    clientY,
    pointerId,
    preventDefault: vi.fn(),
  } as unknown as PointerEvent;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function inputValue(root: ParentNode, label: string): string | null {
  return (
    root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)?.value ??
    null
  );
}

function button(root: ParentNode, label: string): HTMLButtonElement | null {
  return (
    Array.from(root.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === label,
    ) ?? null
  );
}
