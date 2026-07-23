export const CROPPABLE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);
export const CROPPABLE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
] as const;
export const MIME_EXTENSION: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};
