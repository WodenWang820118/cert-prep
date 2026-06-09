import { inject, Injectable, signal } from '@angular/core';
import { EXAM_PREP_API, LLMHealthRead } from '../exam-prep-api';
import { OperationStore } from './operation.store';

@Injectable({ providedIn: 'root' })
export class HealthStore {
  private readonly api = inject(EXAM_PREP_API);
  private readonly operations = inject(OperationStore);

  readonly health = signal<LLMHealthRead | null>(null);

  async load(): Promise<void> {
    const health = await this.api.llmHealth();
    this.health.set(health);
  }

  async refresh(): Promise<void> {
    const health = await this.operations.run(
      'health',
      'Model health refreshed',
      () => this.api.llmHealth(),
    );
    if (health !== null) {
      this.health.set(health);
    }
  }
}
