import { classifyCaptureFile, serializeCaptureResult } from './capture-result';
import type { CaptureResultV1 } from './capture-contracts';

const result: CaptureResultV1 = {
  schemaVersion: '1.0', source: { fileName: 'page.png', mediaType: 'image/png', kind: 'image', sizeBytes: 3 }, status: 'completed', text: 'recognized text', pages: [{ pageNumber: 1, text: 'recognized text' }], startedAt: '2026-07-20T00:00:00Z', completedAt: '2026-07-20T00:00:01Z',
};

describe('capture result helpers', () => {
  it.each([['a.pdf', 'pdf'], ['shot.JPEG', 'image'], ['voice.m4a', 'audio']])('classifies %s', (name, expected) => expect(classifyCaptureFile({ name })).toBe(expected));
  it('rejects unsupported extensions', () => expect(classifyCaptureFile({ name: 'notes.txt' })).toBeNull());
  it('keeps JSON provenance and derives plain text', () => { expect(JSON.parse(serializeCaptureResult(result, 'json')).pages[0].pageNumber).toBe(1); expect(serializeCaptureResult(result, 'text')).toBe('recognized text'); });
});
