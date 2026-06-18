import { computed, inject, Injectable, signal } from '@angular/core';
import {
  EXAM_PREP_API,
  PracticeSessionCreate,
  PracticeAttemptRead,
  PracticeSessionRead,
} from '../exam-prep-api';
import { DraftReviewStore } from './draft-review.store';
import { OperationStore } from './operation.store';
import { ProjectStore } from './project.store';
import { SourceImportStore } from './source-import.store';
import { WrongAnswerReviewStore } from './wrong-answer-review.store';

export type PracticeSessionMode = 'full_document' | 'random_draw';

type PracticeSessionPayload = PracticeSessionCreate &
  Partial<{
    mode: PracticeSessionMode;
    document_id: string;
  }>;

@Injectable({ providedIn: 'root' })
export class PracticeStore {
  private readonly api = inject(EXAM_PREP_API);
  private readonly drafts = inject(DraftReviewStore);
  private readonly operations = inject(OperationStore);
  private readonly projects = inject(ProjectStore);
  private readonly sourceImport = inject(SourceImportStore);
  private readonly wrongAnswers = inject(WrongAnswerReviewStore);

  readonly sessionQuestionCount = signal(5);
  readonly selectedDocumentId = signal<string | null>(null);
  readonly practiceSession = signal<PracticeSessionRead | null>(null);
  readonly selectedAnswer = signal('');
  readonly lastAttempt = signal<PracticeAttemptRead | null>(null);
  readonly answeredQuestionIds = signal<ReadonlySet<string>>(new Set<string>());
  readonly approvedDraftCount = computed(() => this.drafts.approvedDrafts().length);
  readonly approvedDraftsByDocument = computed(() => {
    const counts = new Map<string, number>();
    for (const draft of this.drafts.approvedDrafts()) {
      if (draft.document_id === null) {
        continue;
      }
      counts.set(draft.document_id, (counts.get(draft.document_id) ?? 0) + 1);
    }
    return counts;
  });
  readonly fullExamDocuments = computed(() => {
    const counts = this.approvedDraftsByDocument();
    return this.sourceImport
      .documents()
      .filter(
        (document) =>
          document.status === 'ready' && (counts.get(document.id) ?? 0) > 0,
      );
  });
  readonly effectiveFullExamDocumentId = computed(() => {
    const selectedId = this.selectedDocumentId();
    if (
      selectedId !== null &&
      this.fullExamDocuments().some((document) => document.id === selectedId)
    ) {
      return selectedId;
    }

    return this.fullExamDocuments()[0]?.id ?? null;
  });
  readonly selectedDocumentApprovedCount = computed(() => {
    const documentId = this.effectiveFullExamDocumentId();
    return documentId === null
      ? 0
      : (this.approvedDraftsByDocument().get(documentId) ?? 0);
  });
  readonly fullExamDocumentSelectValue = computed(
    () => this.effectiveFullExamDocumentId() ?? '',
  );
  readonly activeQuestion = computed(() => {
    const session = this.practiceSession();
    if (session === null) {
      return null;
    }

    const answered = this.answeredQuestionIds();
    const nextQuestionId =
      session.question_ids.find((questionId) => !answered.has(questionId)) ??
      null;
    if (nextQuestionId === null) {
      return null;
    }

    return this.drafts.drafts().find((draft) => draft.id === nextQuestionId) ?? null;
  });
  readonly sessionProgress = computed(() => {
    const session = this.practiceSession();
    if (session === null) {
      return '0/0';
    }

    return `${this.answeredQuestionIds().size}/${session.question_ids.length}`;
  });
  readonly sessionComplete = computed(() => {
    const session = this.practiceSession();
    return (
      session !== null &&
      session.question_ids.length > 0 &&
      this.answeredQuestionIds().size >= session.question_ids.length
    );
  });

  reset(): void {
    this.selectedDocumentId.set(null);
    this.practiceSession.set(null);
    this.selectedAnswer.set('');
    this.lastAttempt.set(null);
    this.answeredQuestionIds.set(new Set<string>());
  }

  setSessionQuestionCount(value: string | number): void {
    this.sessionQuestionCount.set(clampInteger(value, 1, 100));
  }

  selectAnswer(choice: string): void {
    this.selectedAnswer.set(choice);
  }

  setSelectedDocumentId(documentId: string): void {
    const nextDocument = this.fullExamDocuments().find(
      (document) => document.id === documentId,
    );
    this.selectedDocumentId.set(nextDocument?.id ?? null);
  }

  approvedCountForDocument(documentId: string): number {
    return this.approvedDraftsByDocument().get(documentId) ?? 0;
  }

  canCreatePracticeSession(mode: PracticeSessionMode): boolean {
    if (this.projects.selectedProject() === null) {
      return false;
    }

    if (mode === 'full_document') {
      return (
        this.effectiveFullExamDocumentId() !== null &&
        this.selectedDocumentApprovedCount() > 0
      );
    }

    return this.approvedDraftCount() > 0 && this.sessionQuestionCount() > 0;
  }

  sessionStartBlocker(mode: PracticeSessionMode): string {
    if (this.projects.selectedProject() === null) {
      return 'Select a project before starting practice.';
    }

    if (mode === 'full_document') {
      return 'Choose a parsed document with approved items.';
    }

    return 'Approve at least one item before starting a random quiz.';
  }

  async createPracticeSession(
    mode: PracticeSessionMode = 'random_draw',
  ): Promise<void> {
    const project = this.projects.selectedProject();
    if (project === null) {
      this.operations.fail('Select a project before starting practice.');
      return;
    }

    if (!this.canCreatePracticeSession(mode)) {
      this.operations.fail(this.sessionStartBlocker(mode));
      return;
    }

    const payload = this.sessionPayload(mode);
    const session = await this.operations.run(
      'session',
      'Practice session ready',
      async () => {
        const created = await this.api.createPracticeSession(project.id, payload);
        return this.api.getPracticeSession(project.id, created.id);
      },
    );
    if (session === null) {
      return;
    }

    this.practiceSession.set(session);
    this.answeredQuestionIds.set(new Set<string>());
    this.selectedAnswer.set('');
    this.lastAttempt.set(null);
    await this.drafts.load(project.id);
  }

  private sessionPayload(mode: PracticeSessionMode): PracticeSessionPayload {
    if (mode === 'full_document') {
      const documentId = this.effectiveFullExamDocumentId();
      return {
        mode,
        document_id: documentId ?? undefined,
        question_count: Math.max(1, this.selectedDocumentApprovedCount()),
      };
    }

    return {
      mode,
      question_count: Math.min(
        this.sessionQuestionCount(),
        Math.max(1, this.approvedDraftCount()),
      ),
    };
  }

  async submitAnswer(): Promise<void> {
    const project = this.projects.selectedProject();
    const session = this.practiceSession();
    const question = this.activeQuestion();
    const answer = this.selectedAnswer();
    if (
      project === null ||
      session === null ||
      question === null ||
      answer.length === 0
    ) {
      this.operations.fail('Choose an answer before submitting.');
      return;
    }

    const attempt = await this.operations.run('attempt', 'Answer recorded', () =>
      this.api.recordPracticeAttempt(project.id, session.id, {
        question_id: question.id,
        selected_answer: answer,
      }),
    );
    if (attempt === null) {
      return;
    }

    this.lastAttempt.set(attempt);
    this.answeredQuestionIds.update((answered) => {
      const next = new Set(answered);
      next.add(question.id);
      return next;
    });
    this.selectedAnswer.set('');
    await this.wrongAnswers.load(project.id);
  }
}

function clampInteger(
  value: string | number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return minimum;
  }

  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}
