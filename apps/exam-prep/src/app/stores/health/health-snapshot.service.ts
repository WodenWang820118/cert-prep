import { inject, Injectable } from '@angular/core';
import { EXAM_PREP_API } from '../../exam-prep-api';
import type { HealthSnapshot } from './contracts/health-runtime.contracts';
import { RuntimeApiClientsService } from './runtime-api-clients.service';

@Injectable({ providedIn: 'root' })
export class HealthSnapshotService {
  private readonly api = inject(EXAM_PREP_API);
  private readonly runtimeApi = inject(RuntimeApiClientsService);

  /**
   * Loads independent health endpoints concurrently while preserving partial
   * success. The health UI can still render Python/OCR status when LLM or
   * runtime-requirement endpoints are unavailable.
   */
  async load(
    onPartialSnapshot?: (snapshot: Partial<HealthSnapshot>) => void,
  ): Promise<HealthSnapshot> {
    const system = this.api.health().then((value) => {
      onPartialSnapshot?.({ system: value });
      return value;
    });
    const llm = this.api.llmHealth().then((value) => {
      onPartialSnapshot?.({ llm: value });
      return value;
    });
    const ocr = this.api.ocrHealth().then((value) => {
      onPartialSnapshot?.({ ocr: value });
      return value;
    });
    const runtimeRequirements = this.loadRuntimeRequirements()
      .then((value) => {
        onPartialSnapshot?.({ runtimeRequirements: value });
        return value;
      })
      .catch(() => []);

    const [systemResult, llmResult, ocrResult, requirementsResult] =
      await Promise.allSettled([system, llm, ocr, runtimeRequirements]);

    const failures = [systemResult, llmResult, ocrResult].filter(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected',
    );
    if (failures.length === 3) {
      throw failures[0].reason;
    }

    return {
      system:
        systemResult.status === 'fulfilled' ? systemResult.value : undefined,
      llm: llmResult.status === 'fulfilled' ? llmResult.value : undefined,
      ocr: ocrResult.status === 'fulfilled' ? ocrResult.value : undefined,
      runtimeRequirements:
        requirementsResult.status === 'fulfilled'
          ? requirementsResult.value
          : [],
    };
  }

  private async loadRuntimeRequirements() {
    const client = this.runtimeApi.runtimeInstallationClient();
    if (client === null) {
      return [];
    }

    return (await client.runtimeRequirements()).items;
  }
}
