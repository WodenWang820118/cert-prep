export interface QuestionNavigatorItem {
  readonly number: number;
  readonly state: 'answered' | 'current' | 'pending';
}
