export type CommandResult<T> =
  | { readonly kind: 'success'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown };

export type BusyAction =
  | 'startup'
  | 'health'
  | 'project'
  | 'upload'
  | 'document-cancel'
  | 'document-retry'
  | 'transcript-edit'
  | 'transcript-translate'
  | 'transcript-translate-all'
  | 'questions'
  | 'saveDraft'
  | 'session'
  | 'attempt'
  | 'review'
  | 'runtime';
