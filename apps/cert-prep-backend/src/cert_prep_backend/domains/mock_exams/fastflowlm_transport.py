from __future__ import annotations

from collections.abc import Callable, Sequence
import json
import os
from pathlib import Path
import subprocess
from typing import Any

from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.domains.mock_exams.deterministic_parser import (
    extract_jlpt_question_blocks,
    source_text_for_prompt,
)
from cert_prep_backend.domains.mock_exams.fastflowlm_client import FastFlowLMClient
from cert_prep_backend.domains.mock_exams.fastflowlm_generation import (
    FastFlowLMGenerationMixin,
)
from cert_prep_backend.domains.mock_exams.fastflowlm_health import FastFlowLMHealthMixin
from cert_prep_backend.domains.mock_exams.fastflowlm_io import FastFlowLMIOMixin
from cert_prep_backend.domains.mock_exams.fastflowlm_onboarding import (
    FastFlowLMModelOnboarding,
)
from cert_prep_backend.domains.mock_exams.fastflowlm_process import (
    terminate_fastflowlm_process_tree,
)
from cert_prep_backend.domains.mock_exams.fastflowlm_resolver import (
    resolve_fastflowlm_executable,
)
from cert_prep_backend.domains.mock_exams.fastflowlm_server import FastFlowLMServerManager
from cert_prep_backend.domains.mock_exams.model_fallback import ModelFallbackEngine
from cert_prep_backend.domains.mock_exams.models import (
    AnswerKeySource,
    DraftSuggestion,
    SourceChunk,
)
from cert_prep_backend.domains.mock_exams.normalization import dedupe_suggestions
from cert_prep_backend.domains.mock_exams.ports import ProviderHealth
from cert_prep_backend.domains.mock_exams.reasoning_parser import (
    EXAM_ITEMS_SCHEMA,
    draft_suggestion_from_item,
)
from cert_prep_backend.domains.mock_exams.response_parsing import (
    answer_from_payload,
    confidence_from_payload,
    fast_first_prompt,
    short_error,
)
from cert_prep_backend.domains.mock_exams.system_probes import available_system_ram_bytes
from cert_prep_contracts.llm import (
    DEFAULT_LLM_LOW_RESOURCE_MODEL,
    DEFAULT_LLM_PRIMARY_MODEL,
    ModelPullProgress,
)


DEFAULT_FASTFLOWLM_PRIMARY_MIN_AVAILABLE_RAM_BYTES = 6 * 1024 * 1024 * 1024
DEFAULT_FASTFLOWLM_AUTO_START_SERVER = True
DEFAULT_FASTFLOWLM_SERVER_START_TIMEOUT_SECONDS = 90.0
DEFAULT_FASTFLOWLM_OWNED_SERVER_IDLE_TIMEOUT_SECONDS = 5.0
FASTFLOWLM_MODEL_RETRY_AFTER_SECONDS = 300.0


class FastFlowLMProvider(
    FastFlowLMHealthMixin,
    FastFlowLMGenerationMixin,
    FastFlowLMIOMixin,
):
    """FastFlowLM-backed mock exam draft provider using its OpenAI-compatible API."""

    provider = "fastflowlm"
    _primary_model_name = DEFAULT_LLM_PRIMARY_MODEL
    _ram_fallback_model = DEFAULT_LLM_LOW_RESOURCE_MODEL

    def __init__(
        self,
        base_url: str,
        model: str,
        timeout_seconds: float,
        executable_path: Path | None = None,
        fallback_models: Sequence[str] = (),
        model_pull_timeout_seconds: float | None = None,
        primary_min_available_ram_bytes: int = (DEFAULT_FASTFLOWLM_PRIMARY_MIN_AVAILABLE_RAM_BYTES),
        auto_start_server: bool = DEFAULT_FASTFLOWLM_AUTO_START_SERVER,
        server_start_timeout_seconds: float = (DEFAULT_FASTFLOWLM_SERVER_START_TIMEOUT_SECONDS),
        owned_server_idle_timeout_seconds: float = (
            DEFAULT_FASTFLOWLM_OWNED_SERVER_IDLE_TIMEOUT_SECONDS
        ),
        owned_server_process_terminator: Callable[[subprocess.Popen], None] = (
            terminate_fastflowlm_process_tree
        ),
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.executable_path = executable_path
        self.timeout_seconds = timeout_seconds
        self.model_pull_timeout_seconds = model_pull_timeout_seconds or timeout_seconds
        self.primary_min_available_ram_bytes = max(0, int(primary_min_available_ram_bytes))
        self.fallback_models = tuple(
            dict.fromkeys(
                fallback.strip()
                for fallback in fallback_models
                if fallback.strip() and fallback.strip() != model
            )
        )
        self._fallback_engine = ModelFallbackEngine(
            primary_model=model,
            fallback_models=self.fallback_models,
            retry_after_seconds=FASTFLOWLM_MODEL_RETRY_AFTER_SECONDS,
            error_shortener=short_error,
        )
        self.fallback_models = self._fallback_engine.fallback_models
        self.auto_start_server = auto_start_server
        self.server_start_timeout_seconds = max(0.1, server_start_timeout_seconds)
        self.owned_server_idle_timeout_seconds = max(0.0, owned_server_idle_timeout_seconds)
        self._client = FastFlowLMClient(
            base_url=self.base_url,
            timeout_seconds=self.timeout_seconds,
        )
        self._server_manager = FastFlowLMServerManager(
            base_url=self.base_url,
            auto_start_server=self.auto_start_server,
            server_start_timeout_seconds=self.server_start_timeout_seconds,
            owned_server_idle_timeout_seconds=self.owned_server_idle_timeout_seconds,
            executable_resolver=lambda: resolve_fastflowlm_executable(self.executable_path),
            start_process=self._start_owned_server_process,
            process_terminator=owned_server_process_terminator,
            served_model_names=self._served_model_names,
            model_to_serve=self._model_to_serve_for_auto_start,
        )
        self._model_onboarding = FastFlowLMModelOnboarding(
            model=self.model,
            executable_resolver=lambda: resolve_fastflowlm_executable(self.executable_path),
            command_timeout_seconds=self.model_pull_timeout_seconds,
            server_start_timeout_seconds=self.server_start_timeout_seconds,
        )

    @property
    def supports_ollama_runtime_installation(self) -> bool:
        return False

    @property
    def starts_on_generation(self) -> bool:
        return self.auto_start_server

    def streaming_generation_kwargs(self) -> dict[str, Any]:
        return {}

    def health(self) -> ProviderHealth:
        """Return FastFlowLM server and configured-model availability."""

        try:
            model_names = self._served_model_names()
        except Exception as exc:
            executable = resolve_fastflowlm_executable(self.executable_path)
            if executable is None:
                detail = "FastFlowLM is not installed."
                unavailable_reason = "fastflowlm_missing"
            else:
                detail = f"FastFlowLM server unavailable at {self.base_url}: {short_error(exc)}"
                unavailable_reason = "fastflowlm_not_running"
            return ProviderHealth(
                provider=self.provider,
                model=self.model,
                available=False,
                detail=detail,
                unavailable_reason=unavailable_reason,
                configured_model=self.model,
                fallback_models=self.fallback_models,
            )

        return self._health_from_model_names(model_names)

    def generate_drafts(self, chunks: Sequence[SourceChunk], limit: int) -> list[DraftSuggestion]:
        """Generate drafts by combining deterministic extraction with reasoning fallback."""

        self.reset_generation_attribution()
        if not chunks:
            return []

        extracted = extract_jlpt_question_blocks(chunks, limit)
        if len(extracted) >= limit:
            return extracted

        generated = self.generate_reasoning_drafts(chunks, limit - len(extracted))
        return dedupe_suggestions([*extracted, *generated], limit)

    def generate_reasoning_drafts(
        self,
        chunks: Sequence[SourceChunk],
        limit: int,
        *,
        num_ctx: int = 8192,
        num_predict: int = 4096,
    ) -> list[DraftSuggestion]:
        """Ask FastFlowLM for structured JSON drafts and validate grounded results."""

        self.reset_generation_attribution()
        if not chunks or limit <= 0:
            return []

        source = source_text_for_prompt(chunks, limit)
        schema = json.dumps(EXAM_ITEMS_SCHEMA, ensure_ascii=False)
        payload = self._with_model_fallback(
            lambda model: self._chat_json(
                model,
                [
                    {
                        "role": "system",
                        "content": (
                            "You convert OCR text from an uploaded JLPT exam into practice-ready "
                            "mock exam questions. Preserve actual exam questions and choices. "
                            "Ignore cover pages, title pages, notes, version notices, copyright "
                            "notices, and general instructions; do not invent questions from them. "
                            "Only output real multiple-choice exam items with a question stem and "
                            "visible choices. If an explicit answer key is present, use it. If it "
                            "is absent, infer the correct answer and mark answer_key_source as "
                            "ai_inferred. Do not include chain-of-thought, hidden reasoning, or "
                            "analysis. Only include a concise user-facing rationale. "
                            f"Return only JSON matching this schema: {schema}"
                        ),
                    },
                    {
                        "role": "user",
                        "content": (
                            f"Create up to {limit} JLPT mock exam items from this page-delimited "
                            "source text. For every item, set answer to the exact choice text, "
                            "include a concise user-facing rationale, include confidence as a "
                            "number from 0 to 1, keep citation_page from the source page, and "
                            "include a source_excerpt copied exactly from the source text. If "
                            "the source only contains title, note, version, or instruction text, "
                            "return an empty items array for that text.\n\n"
                            f"{source}"
                        ),
                    },
                ],
                max_tokens=num_predict,
                context_tokens=num_ctx,
            )
        )
        raw_items = payload.get("items", [])
        if not isinstance(raw_items, list):
            return []

        chunks_by_page = {chunk.page_number: chunk for chunk in chunks}
        chunks_by_id = {chunk.id: chunk for chunk in chunks}
        suggestions: list[DraftSuggestion] = []
        for raw_item in raw_items:
            suggestion = draft_suggestion_from_item(raw_item, chunks_by_page, chunks_by_id)
            if suggestion is None:
                continue
            suggestions.append(suggestion)
            if len(suggestions) >= limit:
                break
        return suggestions

    def generate_fast_first_draft(
        self,
        source_chunk: SourceChunk,
        candidate: DraftSuggestion,
        *,
        num_ctx: int = 1024,
        num_predict: int = 128,
    ) -> DraftSuggestion | None:
        """Ask FastFlowLM to complete one extracted draft with answer/rationale JSON."""

        self.reset_generation_attribution()
        payload = self._with_model_fallback(
            lambda model: self._chat_json(
                model,
                [{"role": "user", "content": fast_first_prompt(candidate)}],
                max_tokens=num_predict,
                context_tokens=num_ctx,
            )
        )
        answer = answer_from_payload(payload.get("answer"), candidate.choices)
        if answer is None:
            return None

        rationale = payload.get("rationale")
        rationale_text = (
            rationale.strip()
            if isinstance(rationale, str) and rationale.strip()
            else "Qwen inferred the answer from the visible stem and choices."
        )
        return DraftSuggestion(
            chunk_id=source_chunk.id,
            question=candidate.question,
            choices=candidate.choices,
            answer=answer,
            answer_key_source=AnswerKeySource.AI_INFERRED,
            rationale=rationale_text,
            citation_page=source_chunk.page_number,
            source_excerpt=candidate.source_excerpt,
            confidence=confidence_from_payload(payload.get("confidence")),
            source_order=candidate.source_order,
            source_question_number=candidate.source_question_number,
            item_kind=candidate.item_kind,
            group_key=candidate.group_key,
            group_prompt=candidate.group_prompt,
        )

    def pull_model(self, progress: Callable[[ModelPullProgress], None]) -> None:
        """Pull the configured FastFlowLM model after explicit user confirmation."""

        executable = resolve_fastflowlm_executable(self.executable_path)
        if executable is None:
            raise ProviderUnavailableError("FastFlowLM is not installed.")
        progress(ModelPullProgress(status=f"pulling {self.model}"))
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        completed = subprocess.run(
            [str(executable), "pull", self.model],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=max(60, int(self.model_pull_timeout_seconds)),
            cwd=executable.parent,
            stdin=subprocess.DEVNULL,
            creationflags=creationflags,
        )
        if completed.returncode != 0:
            output = (completed.stderr or completed.stdout or "").strip()
            raise ProviderUnavailableError(output or "FastFlowLM model pull failed.")
        progress(
            ModelPullProgress(
                status=f"downloaded {self.model}; verification pending",
                completed=100,
                total=100,
            )
        )

    def prepare_model_onboarding(
        self,
        progress: Callable[[ModelPullProgress], None],
    ) -> None:
        """Validate the pinned FastFlowLM runtime before pulling the model."""

        self._model_onboarding.prepare(progress)

    def verify_model_onboarding(
        self,
        progress: Callable[[ModelPullProgress], None],
    ) -> None:
        """Prove the exact model on an isolated app-owned FastFlowLM server."""

        self._model_onboarding.verify(progress)

    def release_resources(self) -> None:
        """Release any FastFlowLM server process owned by this provider after idle."""

        self._server_manager.release_resources()

    def close(self) -> None:
        """Stop the FastFlowLM server process when this provider started it."""

        self._server_manager.close()

    def _available_system_ram_bytes(self) -> int | None:
        return available_system_ram_bytes()
