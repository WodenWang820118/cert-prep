import { inject, Injectable, signal } from '@angular/core';
import { EXAM_PREP_API, LLMHealthRead, OCRHealthRead } from '../exam-prep-api';
import { OperationStore } from './operation.store';

@Injectable({ providedIn: 'root' })
export class HealthStore {
  private readonly api = inject(EXAM_PREP_API);
  private readonly operations = inject(OperationStore);

  readonly llmHealth = signal<LLMHealthRead | null>(null);
  readonly ocrHealth = signal<OCRHealthRead | null>(null);

  async load(): Promise<void> {
    const [llmHealth, ocrHealth] = await Promise.all([
      this.api.llmHealth(),
      this.api.ocrHealth(),
    ]);
    this.llmHealth.set(llmHealth);
    this.ocrHealth.set(ocrHealth);
  }

  async refresh(): Promise<void> {
    const health = await this.operations.run(
      'health',
      'Runtime health refreshed',
      async () => ({
        llm: await this.api.llmHealth(),
        ocr: await this.api.ocrHealth(),
      }),
    );
    if (health !== null) {
      this.llmHealth.set(health.llm);
      this.ocrHealth.set(health.ocr);
    }
  }
}
