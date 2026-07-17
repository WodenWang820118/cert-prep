import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Button } from 'primeng/button';
import { Dialog } from 'primeng/dialog';
import {
  clampImageCropRect,
  ImageCropRect,
  isFullImageCrop,
  SourceImageCropService,
} from './source-image-crop.service';

type CropField = keyof ImageCropRect;

interface ImagePoint {
  readonly x: number;
  readonly y: number;
}

@Component({
  selector: 'app-source-image-crop-dialog',
  imports: [Button, Dialog],
  templateUrl: './source-image-crop-dialog.component.html',
  styleUrl: './source-image-crop-dialog.component.css',
})
export class SourceImageCropDialogComponent {
  readonly sourceFile = input<File | null>(null);
  readonly position = input(0);
  readonly total = input(0);
  readonly cropApplied = output<File>();
  readonly originalKept = output<void>();

  private readonly cropService = inject(SourceImageCropService);
  private readonly cropSurface =
    viewChild<ElementRef<HTMLElement>>('cropSurface');
  private readonly reviewStatus =
    viewChild<ElementRef<HTMLElement>>('reviewStatus');
  private sourceImage: HTMLImageElement | null = null;
  private activePointerId: number | null = null;
  private pointerStart: ImagePoint | null = null;
  private pointerStartCrop: ImageCropRect | null = null;

  protected readonly previewUrl = signal<string | null>(null);
  protected readonly imageReady = signal(false);
  protected readonly sourceWidth = signal(0);
  protected readonly sourceHeight = signal(0);
  protected readonly cropRect = signal<ImageCropRect>({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });
  protected readonly loadError = signal<string | null>(null);
  protected readonly encodeError = signal<string | null>(null);
  protected readonly encoding = signal(false);

  protected readonly dialogHeader = computed(() => {
    const filename = this.sourceFile()?.name;
    return filename === undefined ? 'Crop image' : `Crop image: ${filename}`;
  });
  protected readonly canApplyCrop = computed(
    () =>
      this.imageReady() &&
      !this.encoding() &&
      !isFullImageCrop(
        this.cropRect(),
        this.sourceWidth(),
        this.sourceHeight(),
      ),
  );
  protected readonly cropLeftPercent = computed(() =>
    this.cropPercent(this.cropRect().x, this.sourceWidth()),
  );
  protected readonly cropTopPercent = computed(() =>
    this.cropPercent(this.cropRect().y, this.sourceHeight()),
  );
  protected readonly cropWidthPercent = computed(() =>
    this.cropPercent(this.cropRect().width, this.sourceWidth()),
  );
  protected readonly cropHeightPercent = computed(() =>
    this.cropPercent(this.cropRect().height, this.sourceHeight()),
  );
  protected readonly cropAnnouncement = computed(() => {
    const crop = this.cropRect();
    if (!this.imageReady()) {
      return 'Loading image preview.';
    }
    return `Crop ${crop.width} by ${crop.height} pixels, starting at ${crop.x}, ${crop.y}.`;
  });

  constructor() {
    effect((onCleanup) => {
      const file = this.sourceFile();
      this.resetImageState();
      if (file === null) {
        this.previewUrl.set(null);
        return;
      }
      if (typeof URL.createObjectURL !== 'function') {
        this.previewUrl.set(null);
        this.loadError.set('This browser cannot preview the selected image.');
        return;
      }

      const objectUrl = URL.createObjectURL(file);
      this.previewUrl.set(objectUrl);
      onCleanup(() => URL.revokeObjectURL(objectUrl));
    });
  }

  protected loadImage(event: Event): void {
    const image = event.currentTarget as HTMLImageElement;
    if (image.naturalWidth < 1 || image.naturalHeight < 1) {
      this.failImageLoad();
      return;
    }
    this.sourceImage = image;
    this.sourceWidth.set(image.naturalWidth);
    this.sourceHeight.set(image.naturalHeight);
    this.cropRect.set({
      x: 0,
      y: 0,
      width: image.naturalWidth,
      height: image.naturalHeight,
    });
    this.loadError.set(null);
    this.encodeError.set(null);
    this.imageReady.set(true);
  }

  protected failImageLoad(): void {
    this.sourceImage = null;
    this.imageReady.set(false);
    this.loadError.set(
      'The selected image could not be previewed. You can keep the original file.',
    );
  }

  protected updateCropField(
    field: CropField,
    value: number | string | null,
  ): void {
    if (this.encoding()) {
      return;
    }
    if (value === null || (typeof value === 'string' && value.trim() === '')) {
      return;
    }
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || !this.imageReady()) {
      return;
    }
    this.cropRect.set(
      clampImageCropRect(
        { ...this.cropRect(), [field]: numericValue },
        this.sourceWidth(),
        this.sourceHeight(),
      ),
    );
    this.encodeError.set(null);
  }

  protected updateCropFieldFromInput(field: CropField, event: Event): void {
    const input = event.target as HTMLInputElement | null;
    this.updateCropField(field, input?.value ?? null);
  }

  protected normalizeCropFieldInput(field: CropField, event: Event): void {
    const input = event.target as HTMLInputElement | null;
    if (input !== null) {
      input.value = String(this.cropRect()[field]);
    }
  }

  protected resetCrop(): void {
    if (!this.imageReady() || this.encoding()) {
      return;
    }
    this.cropRect.set({
      x: 0,
      y: 0,
      width: this.sourceWidth(),
      height: this.sourceHeight(),
    });
    this.encodeError.set(null);
  }

  protected keepOriginal(): void {
    if (!this.encoding() && this.sourceFile() !== null) {
      this.originalKept.emit();
    }
  }

  protected async applyCrop(): Promise<void> {
    const file = this.sourceFile();
    const image = this.sourceImage;
    if (file === null || image === null || !this.canApplyCrop()) {
      return;
    }
    this.encoding.set(true);
    this.encodeError.set(null);
    try {
      const croppedFile = await this.cropService.crop(
        file,
        image,
        this.cropRect(),
      );
      this.cropApplied.emit(croppedFile);
    } catch (error) {
      this.encodeError.set(
        error instanceof Error
          ? error.message
          : 'The cropped image could not be created.',
      );
      this.focusReviewStatus();
    } finally {
      this.encoding.set(false);
    }
  }

  focusReviewStatus(): void {
    queueMicrotask(() => {
      if (this.sourceFile() !== null) {
        this.reviewStatus()?.nativeElement.focus();
      }
    });
  }

  protected startCropSelection(event: PointerEvent): void {
    if (!this.imageReady() || this.encoding() || event.button !== 0) {
      return;
    }
    const point = this.imagePoint(event);
    const surface = this.cropSurface()?.nativeElement;
    if (point === null || surface === undefined) {
      return;
    }

    this.activePointerId = event.pointerId;
    this.pointerStart = point;
    this.pointerStartCrop = this.cropRect();
    surface.setPointerCapture?.(event.pointerId);
    this.cropRect.set(
      clampImageCropRect(
        { x: point.x, y: point.y, width: 1, height: 1 },
        this.sourceWidth(),
        this.sourceHeight(),
      ),
    );
    this.encodeError.set(null);
    event.preventDefault();
  }

  protected redrawCropSelection(event: PointerEvent): void {
    if (
      this.encoding() ||
      this.activePointerId !== event.pointerId ||
      this.pointerStart === null
    ) {
      return;
    }
    const point = this.imagePoint(event);
    if (point === null) {
      return;
    }
    this.cropRect.set(
      clampImageCropRect(
        {
          x: Math.min(this.pointerStart.x, point.x),
          y: Math.min(this.pointerStart.y, point.y),
          width: Math.abs(point.x - this.pointerStart.x) + 1,
          height: Math.abs(point.y - this.pointerStart.y) + 1,
        },
        this.sourceWidth(),
        this.sourceHeight(),
      ),
    );
    event.preventDefault();
  }

  protected finishCropSelection(event: PointerEvent): void {
    if (this.activePointerId !== event.pointerId) {
      return;
    }
    if (!this.encoding()) {
      this.redrawCropSelection(event);
    }
    this.releasePointer(event.pointerId);
  }

  protected cancelCropSelection(event: PointerEvent): void {
    if (this.activePointerId !== event.pointerId) {
      return;
    }
    if (!this.encoding() && this.pointerStartCrop !== null) {
      this.cropRect.set(this.pointerStartCrop);
    }
    this.releasePointer(event.pointerId);
  }

  protected cropXMaximum(): number {
    return Math.max(0, this.sourceWidth() - 1);
  }

  protected cropYMaximum(): number {
    return Math.max(0, this.sourceHeight() - 1);
  }

  protected cropWidthMaximum(): number {
    return Math.max(1, this.sourceWidth() - this.cropRect().x);
  }

  protected cropHeightMaximum(): number {
    return Math.max(1, this.sourceHeight() - this.cropRect().y);
  }

  private resetImageState(): void {
    this.sourceImage = null;
    this.activePointerId = null;
    this.pointerStart = null;
    this.pointerStartCrop = null;
    this.imageReady.set(false);
    this.sourceWidth.set(0);
    this.sourceHeight.set(0);
    this.cropRect.set({ x: 0, y: 0, width: 0, height: 0 });
    this.loadError.set(null);
    this.encodeError.set(null);
    this.encoding.set(false);
  }

  private imagePoint(event: PointerEvent): ImagePoint | null {
    const surface = this.cropSurface()?.nativeElement;
    if (surface === undefined) {
      return null;
    }
    const bounds = surface.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return null;
    }
    return {
      x: Math.min(
        this.sourceWidth() - 1,
        Math.max(
          0,
          Math.floor(
            ((event.clientX - bounds.left) / bounds.width) * this.sourceWidth(),
          ),
        ),
      ),
      y: Math.min(
        this.sourceHeight() - 1,
        Math.max(
          0,
          Math.floor(
            ((event.clientY - bounds.top) / bounds.height) *
              this.sourceHeight(),
          ),
        ),
      ),
    };
  }

  private releasePointer(pointerId: number): void {
    const surface = this.cropSurface()?.nativeElement;
    if (surface?.hasPointerCapture?.(pointerId)) {
      surface.releasePointerCapture(pointerId);
    }
    this.activePointerId = null;
    this.pointerStart = null;
    this.pointerStartCrop = null;
  }

  private cropPercent(value: number, total: number): number {
    return total > 0 ? (value / total) * 100 : 0;
  }
}
