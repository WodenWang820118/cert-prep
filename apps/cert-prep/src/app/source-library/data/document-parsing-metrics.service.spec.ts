import type { DocumentRead } from '../../core/domain';
import { DocumentParsingMetricsService } from './document-parsing-metrics.service';

describe('DocumentParsingMetricsService', () => {
  const metrics = new DocumentParsingMetricsService();

  it.each([
    ['ja', 'Transcribing Japanese audio'],
    ['en', 'Transcribing English audio'],
    ['auto', 'Transcribing audio'],
  ])('reports transcription progress for a %s language hint', (language_hint, label) => {
    const document = documentRead({
      source_kind: 'audio',
      page_count: 0,
      processed_page_count: 0,
      status: 'processing',
      language_hint,
      transcription_status: 'pending',
      translation_status: 'pending',
    });

    expect(metrics.progressPercent(document)).toBe(25);
    expect(metrics.progressLabel(document)).toBe(label);
  });

  it('reports translation progress after the English transcript is saved', () => {
    const document = documentRead({
      source_kind: 'audio',
      page_count: 0,
      status: 'processing',
      language_hint: 'en',
      transcription_status: 'succeeded',
      translation_status: 'pending',
    });

    expect(metrics.progressPercent(document)).toBe(75);
    expect(metrics.progressLabel(document)).toBe(
      'English transcript ready / translating to Traditional Chinese',
    );
  });

  it.each([
    ['ja', 'Japanese transcript ready / Traditional Chinese translation failed'],
    ['en', 'English transcript ready / Traditional Chinese translation failed'],
    ['auto', 'Transcript ready / Traditional Chinese translation failed'],
  ])(
    'treats a usable %s transcript with failed translation as complete work',
    (language_hint, label) => {
      const document = documentRead({
        source_kind: 'audio',
        page_count: 0,
        status: 'ready',
        language_hint,
        transcription_status: 'succeeded',
        translation_status: 'failed',
      });

      expect(metrics.progressPercent(document)).toBe(100);
      expect(metrics.progressLabel(document)).toBe(label);
    },
  );

  it('keeps page-based progress for non-audio documents', () => {
    const document = documentRead({
      status: 'processing',
      page_count: 8,
      processed_page_count: 4,
    });

    expect(metrics.progressPercent(document)).toBe(50);
    expect(metrics.progressLabel(document)).toBe('4/8 pages');
  });
});

function documentRead(overrides: Partial<DocumentRead> = {}): DocumentRead {
  return {
    id: 'document-1',
    project_id: 'project-1',
    filename: 'source.pdf',
    sha256: 'sha256',
    language_hint: 'ja',
    page_count: 8,
    has_text: true,
    status: 'ready',
    extraction_method: 'text_recognition',
    ocr_device: null,
    extraction_warnings: null,
    failure_message: null,
    processed_page_count: 8,
    exam_item_count: 0,
    content_profile: 'study_material',
    classification_detail: '',
    chunks_count: 8,
    created_at: '2026-07-19T00:00:00Z',
    updated_at: '2026-07-19T00:00:01Z',
    ...overrides,
  };
}
