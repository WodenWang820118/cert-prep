import type {
  DocumentRead,
  ProjectRead,
  QuestionRead,
} from '../../domain';

export const appProject: ProjectRead = {
  id: 'project-1',
  name: 'Security Study',
  description: 'Local cert prep',
  created_at: '2026-06-17T00:00:00Z',
  updated_at: '2026-06-17T00:00:00Z',
};

export const secondAppProject: ProjectRead = {
  ...appProject,
  id: 'project-2',
  name: 'Network Study',
};

export const appDocument: DocumentRead = {
  id: 'document-1',
  project_id: appProject.id,
  filename: 'security.pdf',
  source_kind: 'pdf',
  sha256: 'abc123',
  language_hint: 'en',
  page_count: 12,
  has_text: true,
  status: 'ready',
  extraction_method: 'text',
  ocr_device: null,
  extraction_warnings: null,
  failure_message: null,
  processed_page_count: 12,
  question_count: 1,
  content_profile: 'vocabulary_single_questions',
  classification_detail: '{"profile":"vocabulary_single_questions"}',
  chunks_count: 6,
  created_at: '2026-06-17T00:00:00Z',
  updated_at: '2026-06-17T00:00:00Z',
};

export const secondAppDocument: DocumentRead = {
  ...appDocument,
  id: 'document-2',
  project_id: secondAppProject.id,
  filename: 'network.pdf',
  source_kind: 'pdf',
};

export const editableAppQuestion: QuestionRead = {
  id: 'question-1',
  project_id: appProject.id,
  document_id: appDocument.id,
  chunk_id: 'chunk-1',
  question: 'Which principle limits permissions?',
  choices: ['Least privilege', 'Privilege sprawl'],
  answer: 'Least privilege',
  answer_key_source: 'manual',
  rationale: 'Permissions stay scoped.',
  citation_page: 2,
  source_excerpt: 'Least privilege limits access.',
  confidence: null,
  source_order: 10001,
  source_question_number: '1',
  item_kind: 'vocabulary_single',
  group_key: null,
  group_prompt: null,
  created_at: '2026-06-17T00:00:00Z',
  updated_at: '2026-06-17T00:00:00Z',
};
