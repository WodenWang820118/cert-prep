import { Injectable } from '@angular/core';

export interface ImageCropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const CROPPABLE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const CROPPABLE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;
const MIME_EXTENSION: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

export function isCroppableImageFile(file: File): boolean {
  const mimeType = file.type.trim().toLowerCase();
  if (CROPPABLE_MIME_TYPES.has(mimeType)) {
    return true;
  }
  const filename = file.name.toLowerCase();
  return CROPPABLE_EXTENSIONS.some((extension) => filename.endsWith(extension));
}

export function clampImageCropRect(
  rect: ImageCropRect,
  sourceWidth: number,
  sourceHeight: number,
): ImageCropRect {
  const width = positiveInteger(sourceWidth);
  const height = positiveInteger(sourceHeight);
  if (width === 0 || height === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const x = clampInteger(rect.x, 0, width - 1);
  const y = clampInteger(rect.y, 0, height - 1);
  return {
    x,
    y,
    width: clampInteger(rect.width, 1, width - x),
    height: clampInteger(rect.height, 1, height - y),
  };
}

export function isFullImageCrop(
  rect: ImageCropRect,
  sourceWidth: number,
  sourceHeight: number,
): boolean {
  const normalized = clampImageCropRect(rect, sourceWidth, sourceHeight);
  return (
    normalized.x === 0 &&
    normalized.y === 0 &&
    normalized.width === positiveInteger(sourceWidth) &&
    normalized.height === positiveInteger(sourceHeight)
  );
}

export function croppedImageFilename(
  sourceFilename: string,
  outputMimeType: string,
): string {
  const lastDot = sourceFilename.lastIndexOf('.');
  const basename =
    lastDot > 0 ? sourceFilename.slice(0, lastDot) : sourceFilename || 'image';
  const extension = MIME_EXTENSION[outputMimeType] ?? '.png';
  return `${basename}-cropped${extension}`;
}

@Injectable({ providedIn: 'root' })
export class SourceImageCropService {
  async crop(
    sourceFile: File,
    sourceImage: HTMLImageElement,
    cropRect: ImageCropRect,
  ): Promise<File> {
    const rect = clampImageCropRect(
      cropRect,
      sourceImage.naturalWidth,
      sourceImage.naturalHeight,
    );
    if (rect.width === 0 || rect.height === 0) {
      throw new Error('The image dimensions are unavailable for cropping.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = rect.width;
    canvas.height = rect.height;
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error('Image cropping is unavailable in this browser.');
    }
    context.drawImage(
      sourceImage,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      rect.width,
      rect.height,
    );

    const preferredMimeType = preferredCropMimeType(sourceFile);
    const blob = await canvasBlob(canvas, preferredMimeType);
    const outputMimeType = CROPPABLE_MIME_TYPES.has(blob.type)
      ? blob.type
      : preferredMimeType;
    return new File(
      [blob],
      croppedImageFilename(sourceFile.name, outputMimeType),
      {
        type: outputMimeType,
        lastModified: Date.now(),
      },
    );
  }
}

function preferredCropMimeType(file: File): string {
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

function canvasBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const quality = mimeType === 'image/png' ? undefined : 0.92;
    canvas.toBlob(
      (blob) => {
        if (blob === null) {
          reject(new Error('The cropped image could not be encoded.'));
          return;
        }
        resolve(blob);
      },
      mimeType,
      quality,
    );
  });
}

function positiveInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  const normalized = Number.isFinite(value) ? Math.trunc(value) : minimum;
  return Math.min(maximum, Math.max(minimum, normalized));
}
