import { Injectable } from '@angular/core';
import { defer, map, Observable } from 'rxjs';
import type { ImageCropRect } from './contracts/source-image-crop.contracts';
import {
  CROPPABLE_EXTENSIONS,
  CROPPABLE_MIME_TYPES,
  MIME_EXTENSION,
} from './constants/source-image-crop.constants';

@Injectable({ providedIn: 'root' })
export class SourceImageCropService {
  isCroppableImageFile(file: File): boolean {
    const mimeType = file.type.trim().toLowerCase();
    if (CROPPABLE_MIME_TYPES.has(mimeType)) {
      return true;
    }
    const filename = file.name.toLowerCase();
    return CROPPABLE_EXTENSIONS.some((extension) => filename.endsWith(extension));
  }

  clampImageCropRect(
    rect: ImageCropRect,
    sourceWidth: number,
    sourceHeight: number,
  ): ImageCropRect {
    const width = this.positiveInteger(sourceWidth);
    const height = this.positiveInteger(sourceHeight);
    if (width === 0 || height === 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }

    const x = this.clampInteger(rect.x, 0, width - 1);
    const y = this.clampInteger(rect.y, 0, height - 1);
    return {
      x,
      y,
      width: this.clampInteger(rect.width, 1, width - x),
      height: this.clampInteger(rect.height, 1, height - y),
    };
  }

  isFullImageCrop(
    rect: ImageCropRect,
    sourceWidth: number,
    sourceHeight: number,
  ): boolean {
    const normalized = this.clampImageCropRect(rect, sourceWidth, sourceHeight);
    return (
      normalized.x === 0 &&
      normalized.y === 0 &&
      normalized.width === this.positiveInteger(sourceWidth) &&
      normalized.height === this.positiveInteger(sourceHeight)
    );
  }

  croppedImageFilename(sourceFilename: string, outputMimeType: string): string {
    const lastDot = sourceFilename.lastIndexOf('.');
    const basename =
      lastDot > 0 ? sourceFilename.slice(0, lastDot) : sourceFilename || 'image';
    const extension = MIME_EXTENSION[outputMimeType] ?? '.png';
    return `${basename}-cropped${extension}`;
  }

  crop(
    sourceFile: File,
    sourceImage: HTMLImageElement,
    cropRect: ImageCropRect,
  ): Observable<File> {
    return defer(() => {
      const rect = this.clampImageCropRect(cropRect, sourceImage.naturalWidth, sourceImage.naturalHeight);
      if (rect.width === 0 || rect.height === 0) throw new Error('The image dimensions are unavailable for cropping.');
      const canvas = document.createElement('canvas');
      canvas.width = rect.width;
      canvas.height = rect.height;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('Image cropping is unavailable in this browser.');
      context.drawImage(sourceImage, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
      const preferredMimeType = this.preferredCropMimeType(sourceFile);
      return this.canvasBlob(canvas, preferredMimeType).pipe(map((blob) => {
        const outputMimeType = CROPPABLE_MIME_TYPES.has(blob.type) ? blob.type : preferredMimeType;
        return new File([blob], this.croppedImageFilename(sourceFile.name, outputMimeType), { type: outputMimeType, lastModified: Date.now() });
      }));
    });
  }

  private preferredCropMimeType(file: File): string {
  const mimeType = file.type.trim().toLowerCase();
  if (CROPPABLE_MIME_TYPES.has(mimeType)) {
    return mimeType;
  }
  const filename = file.name.toLowerCase();
  if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (filename.endsWith('.webp')) {
    return 'image/webp';
  }
  return 'image/png';
  }

  private canvasBlob(canvas: HTMLCanvasElement, mimeType: string): Observable<Blob> {
  return new Observable<Blob>((subscriber) => {
    const quality = mimeType === 'image/png' ? undefined : 0.92;
    canvas.toBlob(
      (blob) => {
        if (blob === null) {
          subscriber.error(new Error('The cropped image could not be encoded.'));
          return;
        }
        subscriber.next(blob);
        subscriber.complete();
      },
      mimeType,
      quality,
    );
  });
  }

  private positiveInteger(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }

  private clampInteger(value: number, minimum: number, maximum: number): number {
    const normalized = Number.isFinite(value) ? Math.trunc(value) : minimum;
    return Math.min(maximum, Math.max(minimum, normalized));
  }
}
