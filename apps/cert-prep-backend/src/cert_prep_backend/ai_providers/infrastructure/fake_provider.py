from __future__ import annotations

from cert_prep_backend.ai_providers.domain.provider import ProviderHealth
from cert_prep_backend.platform.config import DEFAULT_OLLAMA_MODEL
from cert_prep_contracts.llm import GenerationAttribution


class FakeLLMProvider:
    """Deterministic local provider used when Ollama is not configured.

    It is always available and has no model to call: Question Authoring writes placeholder
    drafts for it.
    """

    provider = "fake"

    def __init__(self, model: str = DEFAULT_OLLAMA_MODEL) -> None:
        self.model = model

    def health(self) -> ProviderHealth:
        """Return an always-available health snapshot for local deterministic drafts."""

        return ProviderHealth(
            provider=self.provider,
            model=self.model,
            available=True,
            detail="deterministic local fake provider",
            configured_model=self.model,
            effective_model=self.model,
        )

    def reset_generation_attribution(self) -> None:
        return None

    def generation_attribution(self) -> GenerationAttribution:
        return GenerationAttribution(self.provider, self.model)
