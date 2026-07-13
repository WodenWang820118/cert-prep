import { computed, inject, Injectable, signal } from '@angular/core';
import type {
  FastFlowLMTermsDecision,
  LLMProviderSelectionRead,
} from '../../cert-prep-api';
import { CERT_PREP_API } from '../../cert-prep-api';
import { OperationStore } from '../operation.store';

type ProviderSelection = LLMProviderSelectionRead;
type TermsDecision = FastFlowLMTermsDecision;

const INVALID_SELECTION_MESSAGE =
  'FastFlowLM terms could not be verified. Refresh runtime status and try again.';
const FASTFLOWLM_ALPHA_TERMS_VERSION = '0.9.43';
const FASTFLOWLM_ALPHA_TERMS_URL =
  'https://raw.githubusercontent.com/FastFlowLM/FastFlowLM/v0.9.43/src/inno/terms.txt';

@Injectable({ providedIn: 'root' })
export class FastFlowOnboardingStore {
  private readonly api = inject(CERT_PREP_API);
  private readonly operations = inject(OperationStore);

  readonly selection = signal<ProviderSelection | null>(null);
  readonly consentVisible = signal(false);
  readonly loading = signal(false);
  readonly decisionSaving = signal(false);
  readonly acknowledged = signal(false);
  readonly termsVersion = computed(
    () => this.selection()?.terms_version?.trim() || null,
  );
  readonly termsUrl = computed(
    () => this.selection()?.terms_url?.trim() || null,
  );

  async open(canReview: boolean): Promise<void> {
    if (!canReview || this.loading() || this.decisionSaving()) {
      return;
    }

    this.loading.set(true);
    this.consentVisible.set(false);
    this.acknowledged.set(false);
    this.selection.set(null);

    try {
      const selection = await this.api.llmProviderSelection();
      if (!this.isReviewableSelection(selection)) {
        this.operations.fail(INVALID_SELECTION_MESSAGE);
        return;
      }

      this.selection.set(selection);
      this.consentVisible.set(true);
    } catch (error) {
      this.operations.fail(this.errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  setAcknowledged(value: boolean): void {
    if (!this.decisionSaving()) {
      this.acknowledged.set(value);
    }
  }

  close(): void {
    if (this.decisionSaving()) {
      return;
    }

    this.consentVisible.set(false);
    this.acknowledged.set(false);
  }

  async accept(refresh: () => Promise<void>): Promise<boolean> {
    if (!this.acknowledged()) {
      return false;
    }

    return this.saveDecision('accepted', refresh);
  }

  async decline(refresh: () => Promise<void>): Promise<boolean> {
    return this.saveDecision('declined', refresh);
  }

  private async saveDecision(
    decision: TermsDecision,
    refresh: () => Promise<void>,
  ): Promise<boolean> {
    const selection = this.selection();
    if (
      !this.consentVisible() ||
      this.decisionSaving() ||
      !this.isReviewableSelection(selection)
    ) {
      return false;
    }

    const termsVersion = selection.terms_version.trim();
    this.decisionSaving.set(true);
    try {
      const updatedSelection = await this.api.decideFastflowlmTerms({
        decision,
        terms_version: termsVersion,
      });
      if (!this.isExpectedDecisionResponse(updatedSelection, decision)) {
        throw new Error(INVALID_SELECTION_MESSAGE);
      }

      await refresh();
      this.selection.set(updatedSelection);
      this.consentVisible.set(false);
      this.acknowledged.set(false);
      return true;
    } catch (error) {
      this.operations.fail(this.errorMessage(error));
      return false;
    } finally {
      this.decisionSaving.set(false);
    }
  }

  private isReviewableSelection(
    selection: ProviderSelection | null,
  ): selection is ProviderSelection & {
    terms_version: string;
    terms_url: string;
  } {
    if (
      selection === null ||
      selection.selected_provider !== 'fastflowlm' ||
      !selection.hardware_compatible ||
      !selection.requires_terms_acceptance ||
      selection.terms_accepted ||
      !this.hasPinnedTerms(selection)
    ) {
      return false;
    }

    return true;
  }

  private isExpectedDecisionResponse(
    selection: ProviderSelection,
    decision: TermsDecision,
  ): boolean {
    if (decision === 'accepted') {
      return (
        selection.selected_provider === 'fastflowlm' &&
        selection.effective_provider === 'fastflowlm' &&
        selection.hardware_compatible &&
        selection.requires_terms_acceptance &&
        selection.terms_accepted &&
        selection.runtime_requirement_kind === 'fastflowlm' &&
        selection.model_requirement_kind === 'fastflowlm_model' &&
        this.hasPinnedTerms(selection)
      );
    }

    return (
      selection.selected_provider === 'ollama' &&
      selection.effective_provider === 'ollama' &&
      !selection.requires_terms_acceptance &&
      !selection.terms_accepted &&
      selection.terms_version === null &&
      selection.terms_url === null &&
      selection.runtime_requirement_kind === 'ollama' &&
      selection.model_requirement_kind === 'ollama_model'
    );
  }

  private hasPinnedTerms(
    selection: ProviderSelection,
  ): selection is ProviderSelection & {
    terms_version: string;
    terms_url: string;
  } {
    return (
      typeof selection.terms_version === 'string' &&
      selection.terms_version.trim() === FASTFLOWLM_ALPHA_TERMS_VERSION &&
      typeof selection.terms_url === 'string' &&
      selection.terms_url.trim() === FASTFLOWLM_ALPHA_TERMS_URL
    );
  }

  private errorMessage(error: unknown): string {
    const httpError = error as { error?: unknown; message?: unknown };
    if (
      typeof httpError.error === 'object' &&
      httpError.error !== null &&
      'message' in httpError.error &&
      typeof (httpError.error as { message?: unknown }).message === 'string'
    ) {
      return (httpError.error as { message: string }).message;
    }
    if (typeof httpError.error === 'string' && httpError.error.length > 0) {
      return httpError.error;
    }
    if (typeof httpError.message === 'string' && httpError.message.length > 0) {
      return httpError.message;
    }
    return 'FastFlowLM onboarding did not complete.';
  }
}
