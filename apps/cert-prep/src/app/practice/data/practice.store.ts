import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { from, map, Observable, of, switchMap } from 'rxjs';
import { CERT_PREP_API } from '../../core/data';
import type {
  PracticeAttemptRead,
  PracticeSessionRead,
  PracticeSessionSummaryRead,
} from '../../core/domain';
import { CertPrepHttpResourceClient } from '../../core/data';
import type {
  PracticeSessionMode,
  PracticeSessionPayload,
  PracticeSessionQuestion,
} from '../domain';
import { PracticeSessionPayloadService } from './practice-session-payload.service';
import { QuestionsStore } from '../../authoring/data';
import { OperationStore } from '../../core/data';
import { ProjectStore } from '../../projects/data';
import { SourceImportStore } from '../../source-library/data';
import { WrongAnswerRetryStore } from './wrong-answer-retry.store';

@Injectable({ providedIn: 'root' })
export class PracticeStore {
  private readonly api = inject(CERT_PREP_API);
  private readonly questionsStore = inject(QuestionsStore);
  private readonly operations = inject(OperationStore);
  private readonly projects = inject(ProjectStore);
  private readonly resources = inject(CertPrepHttpResourceClient);
  private readonly activeSessionsQueryEnabled = signal(false);
  private readonly sessionPayloads = inject(PracticeSessionPayloadService);
  private readonly sourceImport = inject(SourceImportStore);
  private readonly wrongAnswers = inject(WrongAnswerRetryStore);

  readonly sessionQuestionCount = signal(5);
  readonly selectedSourceId = signal<string | null>(null);
  readonly practiceSession = signal<PracticeSessionRead | null>(null);
  private readonly activeSessionsResource =
    this.resources.activePracticeSessions(() =>
      this.activeSessionsQueryEnabled()
        ? this.projects.selectedProjectId()
        : null,
    );
  readonly resumableSession = signal<PracticeSessionSummaryRead | null>(null);
  private readonly activeSessionSync = effect(() => {
    const status = this.activeSessionsResource.status();
    if (
      this.practiceSession() === null &&
      (status === 'resolved' || status === 'local')
    ) {
      this.resumableSession.set(this.activeSessionsResource.value()[0] ?? null);
    }
  });
  readonly abandonConfirmationPending = signal(false);
  readonly selectedAnswer = signal('');
  readonly lastAttempt = signal<PracticeAttemptRead | null>(null);
  readonly answeredQuestionIds = signal<ReadonlySet<string>>(new Set<string>());
  readonly questionCount = computed(
    () => this.questionsStore.playableQuestions().length,
  );
  readonly effectiveRandomQuestionCount = computed(() =>
    this.sessionPayloads.effectiveRandomQuestionCount(
      this.sessionQuestionCount(),
      this.questionCount(),
    ),
  );
  readonly questionsBySource = computed(() => {
    const counts = new Map<string, number>();
    for (const question of this.questionsStore.playableQuestions()) {
      if (question.source_id === null) {
        continue;
      }
      counts.set(question.source_id, (counts.get(question.source_id) ?? 0) + 1);
    }
    return counts;
  });
  readonly wholeSources = computed(() => {
    const counts = this.questionsBySource();
    return this.sourceImport
      .sources()
      .filter(
        (source) =>
          source.status === 'ready' && (counts.get(source.id) ?? 0) > 0,
      );
  });
  readonly effectiveWholeSourceId = computed(() => {
    const activeSourceId = this.sourceImport.activeSourceId();
    if (
      activeSourceId !== null &&
      this.wholeSources().some(
        (source) => source.id === activeSourceId,
      )
    ) {
      return activeSourceId;
    }

    const selectedId = this.selectedSourceId();
    if (
      selectedId !== null &&
      this.wholeSources().some((source) => source.id === selectedId)
    ) {
      return selectedId;
    }

    return this.wholeSources()[0]?.id ?? null;
  });
  readonly selectedSourceQuestionCount = computed(() => {
    const sourceId = this.effectiveWholeSourceId();
    return sourceId === null
      ? 0
      : (this.questionsBySource().get(sourceId) ?? 0);
  });
  readonly wholeSourceSelectValue = computed(
    () => this.effectiveWholeSourceId() ?? '',
  );
  readonly activeQuestion = computed(() => {
    const session = this.practiceSession();
    if (session === null) {
      return null;
    }

    const answered = this.answeredQuestionIds();
    const questionIds = this.questionIdsForSession(session);
    const nextQuestionId =
      questionIds.find((questionId) => !answered.has(questionId)) ?? null;
    if (nextQuestionId === null) {
      return null;
    }

    const snapshotQuestion = this.snapshotQuestion(session, nextQuestionId);
    if (snapshotQuestion !== null) {
      return snapshotQuestion;
    }

    // Older sessions can lack immutable snapshots. In that compatibility path,
    // only still-playable live questions are surfaced to the runner.
    return (
      this.questionsStore
        .playableQuestions()
        .find((question) => question.id === nextQuestionId) ?? null
    );
  });
  readonly sessionProgress = computed(() => {
    const session = this.practiceSession();
    if (session === null) {
      return '0/0';
    }

    return `${this.answeredQuestionIds().size}/${this.questionIdsForSession(session).length}`;
  });
  readonly sessionComplete = computed(() => {
    const session = this.practiceSession();
    const questionIds =
      session === null ? [] : this.questionIdsForSession(session);
    return (
      session !== null &&
      questionIds.length > 0 &&
      this.answeredQuestionIds().size >= questionIds.length
    );
  });

  reset(): void {
    this.selectedSourceId.set(null);
    this.practiceSession.set(null);
    this.resumableSession.set(null);
    this.abandonConfirmationPending.set(false);
    this.selectedAnswer.set('');
    this.lastAttempt.set(null);
    this.answeredQuestionIds.set(new Set<string>());
  }

  setSessionQuestionCount(value: string | number): void {
    this.sessionQuestionCount.set(
      this.sessionPayloads.clampQuestionCount(value),
    );
  }

  selectAnswer(choice: string): void {
    this.selectedAnswer.set(choice);
  }

  setSelectedSourceId(sourceId: string): void {
    const nextSource = this.wholeSources().find(
      (source) => source.id === sourceId,
    );
    this.selectedSourceId.set(nextSource?.id ?? null);
    if (nextSource !== undefined) {
      this.sourceImport.setActiveSourceId(nextSource.id);
    }
  }

  questionCountForSource(sourceId: string): number {
    return this.questionsBySource().get(sourceId) ?? 0;
  }

  canCreatePracticeSession(mode: PracticeSessionMode): boolean {
    if (this.projects.selectedProject() === null) {
      return false;
    }

    if (this.resumableSession() !== null) {
      return false;
    }

    if (this.reviewRetryInProgress() && mode !== 'review_retry') {
      return false;
    }

    if (mode === 'full_source') {
      return (
        this.effectiveWholeSourceId() !== null &&
        this.selectedSourceQuestionCount() > 0
      );
    }

    return this.questionCount() > 0 && this.sessionQuestionCount() > 0;
  }

  sessionStartBlocker(mode: PracticeSessionMode): string {
    if (this.projects.selectedProject() === null) {
      return 'Select a project before starting practice.';
    }

    if (this.resumableSession() !== null) {
      return 'Resume or abandon the active practice session before starting another.';
    }

    if (this.reviewRetryInProgress() && mode !== 'review_retry') {
      return 'Finish the active review retry before starting a new practice session.';
    }

    if (mode === 'full_source') {
      return 'Choose a parsed source with generated questions.';
    }

    return 'Generate at least one question before starting a random draw.';
  }

  createPracticeSession(
    mode: PracticeSessionMode = 'random_draw',
  ): void {
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
    this.operations
      .run('session', 'Practice session ready', (signal) =>
        from(this.api.createPracticeSession(project.id, payload, { signal })).pipe(
          switchMap((created) =>
            from(this.api.getPracticeSession(project.id, created.id, { signal })),
          ),
        ),
      )
      .subscribe((session) => {
        if (session === null) return;
        this.practiceSession.set(session);
        this.resumableSession.set(null);
        this.activeSessionsResource.set([]);
        this.abandonConfirmationPending.set(false);
        this.answeredQuestionIds.set(new Set<string>());
        this.selectedAnswer.set('');
        this.lastAttempt.set(null);
        this.questionsStore.load(project.id);
      });
  }

  createReviewRetrySession(
    attemptIds: readonly string[],
  ): Observable<boolean> {
    const project = this.projects.selectedProject();
    if (project === null) {
      this.operations.fail('Select a project before starting review practice.');
      return of(false);
    }

    if (attemptIds.length === 0) {
      this.operations.fail('Choose at least one wrong answer to retry.');
      return of(false);
    }

    return this.operations
      .run('session', 'Review practice ready', (signal) =>
        this.api.createPracticeSession(project.id, {
          mode: 'review_retry',
          wrong_attempt_ids: [...attemptIds],
          question_count: attemptIds.length,
        }, { signal }).pipe(
          switchMap((created) =>
            from(this.api.getPracticeSession(project.id, created.id, { signal })),
          ),
        ),
      )
      .pipe(
        map((session) => {
          if (session === null) return false;
          this.practiceSession.set(session);
          this.resumableSession.set(null);
          this.activeSessionsResource.set([]);
          this.abandonConfirmationPending.set(false);
          this.answeredQuestionIds.set(new Set<string>());
          this.selectedAnswer.set('');
          this.lastAttempt.set(null);
          return true;
        }),
      );
  }

  loadActiveSession(projectId: string): void {
    if (this.projects.selectedProject()?.id !== projectId) {
      return;
    }
    if (!this.activeSessionsQueryEnabled()) {
      this.activeSessionsQueryEnabled.set(true);
      return;
    }
    this.activeSessionsResource.reload();
    this.abandonConfirmationPending.set(false);
  }

  resumeActiveSession(): void {
    const project = this.projects.selectedProject();
    const summary = this.resumableSession();
    if (project === null || summary === null) {
      return;
    }
    this.operations
      .run('session', 'Practice session resumed', (signal) =>
        from(this.api.getPracticeSession(project.id, summary.id, { signal })),
      )
      .subscribe((session) => {
        if (session === null || this.projects.selectedProject()?.id !== project.id) return;
        this.practiceSession.set(session);
        this.resumableSession.set(null);
        this.activeSessionsResource.set([]);
        this.abandonConfirmationPending.set(false);
        this.answeredQuestionIds.set(new Set(session.attempts.map((attempt) => attempt.question_id)));
        this.lastAttempt.set(session.attempts[session.attempts.length - 1] ?? null);
        this.selectedAnswer.set('');
        this.questionsStore.load(project.id);
      });
  }

  requestAbandonActiveSession(): void {
    if (this.resumableSession() !== null) {
      this.abandonConfirmationPending.set(true);
    }
  }

  cancelAbandonActiveSession(): void {
    this.abandonConfirmationPending.set(false);
  }

  confirmAbandonActiveSession(): void {
    const project = this.projects.selectedProject();
    const summary = this.resumableSession();
    if (
      project === null ||
      summary === null ||
      !this.abandonConfirmationPending()
    ) {
      return;
    }
    this.operations
      .run('session', 'Practice session abandoned', (signal) =>
        from(this.api.abandonPracticeSession(project.id, summary.id, { signal })),
      )
      .subscribe((abandoned) => {
        if (abandoned === null || this.projects.selectedProject()?.id !== project.id) return;
        this.activeSessionsResource.set([]);
        this.resumableSession.set(null);
        this.abandonConfirmationPending.set(false);
        this.practiceSession.set(null);
        this.answeredQuestionIds.set(new Set<string>());
        this.selectedAnswer.set('');
        this.lastAttempt.set(null);
      });
  }

  private sessionPayload(mode: PracticeSessionMode): PracticeSessionPayload {
    return this.sessionPayloads.createPayload({
      mode,
      wholeSourceId: this.effectiveWholeSourceId(),
      selectedSourceQuestionCount: this.selectedSourceQuestionCount(),
      sessionQuestionCount: this.sessionQuestionCount(),
      questionCount: this.questionCount(),
    });
  }

  private questionIdsForSession(
    session: PracticeSessionRead,
  ): readonly string[] {
    return session.questions.length > 0
      ? session.questions.map((question) => question.id)
      : session.question_ids;
  }

  private snapshotQuestion(
    session: PracticeSessionRead,
    questionId: string,
  ): PracticeSessionQuestion | null {
    return (
      session.questions.find((question) => question.id === questionId) ?? null
    );
  }

  private reviewRetryInProgress(): boolean {
    const session = this.practiceSession();
    return (
      session !== null &&
      session.mode === 'review_retry' &&
      !this.sessionComplete()
    );
  }

  submitAnswer(): void {
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

    this.operations
      .run('attempt', 'Answer recorded', (signal) =>
        from(this.api.recordPracticeAttempt(project.id, session.id, {
          question_id: question.id,
          selected_answer: answer,
        }, { signal })),
      )
      .subscribe((attempt) => {
        if (attempt === null) return;
        this.lastAttempt.set(attempt);
        this.answeredQuestionIds.update((answered) => {
          const next = new Set(answered);
          next.add(question.id);
          return next;
        });
        this.selectedAnswer.set('');
        this.wrongAnswers.load(project.id);
      });
  }
}
