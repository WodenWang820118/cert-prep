export interface ImageCropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type CropField = keyof ImageCropRect;

export interface ImagePoint {
  readonly x: number;
  readonly y: number;
}
