import type { DocumentRead } from '../../cert-prep-api';
import { DocumentParsingMetricsService } from './document-parsing-metrics.service';

describe('DocumentParsingMetricsService', () => {
  const metrics = new DocumentParsingMetricsService();

  it('reports phase-based progress while Japanese audio is transcribing', () => {
    const document = documentRead({
      source_kind: 'audio',
      page_count: 0,
      processed_page_count: 0,
      status: 'processing',
      transcription_status: 'pending',
      translation_status: 'pending',
    });

    expect(metrics.progressPercent(document)).toBe(25);
    expect(metrics.progressLabel(document)).toBe(
      'Transcribing Japanese audio',
    );
  });

  it('reports translation progress after the Japanese transcript is saved', () => {
    const document = documentRead({
      source_kind: 'audio',
      page_count: 0,
      status: 'processing',
      transcription_status: 'succeeded',
      translation_status: 'pending',
    });

    expect(metrics.progressPercent(document)).toBe(75);
    expect(metrics.progressLabel(document)).toBe(
      'Japanese transcript ready / translating to Traditional Chinese',
    );
  });

  it('treats a usable transcript with failed translation as complete work', () => {
    const document = documentRead({
      source_kind: 'audio',
      page_count: 0,
      status: 'ready',
      transcription_status: 'succeeded',
      translation_status: 'failed',
    });

    expect(metrics.progressPercent(document)).toBe(100);
    expect(metrics.progressLabel(document)).toBe(
      'Japanese transcript ready / Traditional Chinese translation failed',
    );
  });

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
    extraction_method: 'embedded_text',
    ocr_device: null,
    ocr_fallback_reason: null,
    ocr_duration_ms: 0,
    processed_page_count: 8,
    parse_wall_duration_ms: 0,
    render_duration_ms: 0,
    ocr_engine_duration_ms: 0,
    ocr_worker_count: 0,
    first_chunk_ms: 0,
    exam_item_count: 0,
    content_profile: 'study_material',
    classification_detail: '',
    chunks_count: 8,
    created_at: '2026-07-19T00:00:00Z',
    updated_at: '2026-07-19T00:00:01Z',
    ...overrides,
  };
}
