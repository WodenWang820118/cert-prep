import type { SourceRead } from '../../core/domain';

export type SourceLabel = Pick<SourceRead, 'id' | 'filename'>;
