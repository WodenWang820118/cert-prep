import {
  clampImageCropRect,
  croppedImageFilename,
  isCroppableImageFile,
  isFullImageCrop,
  SourceImageCropService,
} from './source-image-crop.service';

describe('SourceImageCropService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('recognizes supported image MIME types and extension hints', () => {
    expect(
      isCroppableImageFile(
        new File(['png'], 'capture.bin', { type: 'image/png' }),
      ),
    ).toBe(true);
    expect(isCroppableImageFile(new File(['jpeg'], 'capture.JPEG'))).toBe(true);
    expect(
      isCroppableImageFile(
        new File(['gif'], 'capture.gif', { type: 'image/gif' }),
      ),
    ).toBe(false);
    expect(
      isCroppableImageFile(
        new File(['pdf'], 'guide.pdf', { type: 'application/pdf' }),
      ),
    ).toBe(false);
  });

  it('clamps crop bounds to positive pixels inside the source image', () => {
    expect(
      clampImageCropRect({ x: 8, y: -5, width: 99, height: 0 }, 10, 6),
    ).toEqual({ x: 8, y: 0, width: 2, height: 1 });
    expect(isFullImageCrop({ x: 0, y: 0, width: 10, height: 6 }, 10, 6)).toBe(
      true,
    );
    expect(isFullImageCrop({ x: 1, y: 0, width: 9, height: 6 }, 10, 6)).toBe(
      false,
    );
  });

  it('adds a visible cropped suffix that matches the encoded type', () => {
    expect(croppedImageFilename('screen.PNG', 'image/png')).toBe(
      'screen-cropped.png',
    );
    expect(croppedImageFilename('photo.jpeg', 'image/jpeg')).toBe(
      'photo-cropped.jpg',
    );
    expect(croppedImageFilename('', 'image/webp')).toBe('image-cropped.webp');
  });

  it('draws the bounded source region and returns the encoded file', async () => {
    const drawImage = vi.fn();
    const encodedBlob = new Blob(['encoded'], { type: 'image/jpeg' });
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toBlob: vi.fn(
        (callback: BlobCallback, mimeType?: string, quality?: number) => {
          expect(mimeType).toBe('image/jpeg');
          expect(quality).toBe(0.92);
          callback(encodedBlob);
        },
      ),
    } as unknown as HTMLCanvasElement;
    vi.spyOn(document, 'createElement').mockReturnValue(canvas);
    const image = {
      naturalWidth: 12,
      naturalHeight: 8,
    } as HTMLImageElement;
    const service = new SourceImageCropService();

    const cropped = await service.crop(
      new File(['source'], 'photo.jpeg', { type: 'image/jpeg' }),
      image,
      { x: 2, y: 1, width: 6, height: 4 },
    );

    expect(canvas.width).toBe(6);
    expect(canvas.height).toBe(4);
    expect(drawImage).toHaveBeenCalledWith(image, 2, 1, 6, 4, 0, 0, 6, 4);
    expect(cropped.name).toBe('photo-cropped.jpg');
    expect(cropped.type).toBe('image/jpeg');
    expect(cropped.size).toBe(encodedBlob.size);
  });

  it('rejects when the browser cannot encode the cropped canvas', async () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage: vi.fn() })),
      toBlob: vi.fn((callback: BlobCallback) => callback(null)),
    } as unknown as HTMLCanvasElement;
    vi.spyOn(document, 'createElement').mockReturnValue(canvas);
    const service = new SourceImageCropService();

    await expect(
      service.crop(
        new File(['source'], 'capture.png', { type: 'image/png' }),
        { naturalWidth: 4, naturalHeight: 4 } as HTMLImageElement,
        { x: 0, y: 0, width: 2, height: 2 },
      ),
    ).rejects.toThrow('could not be encoded');
  });
});
