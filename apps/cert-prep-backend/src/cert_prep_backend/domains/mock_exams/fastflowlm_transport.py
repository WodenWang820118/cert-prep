from __future__ import annotations

from collections.abc import Callable, Sequence
import json
import os
from pathlib import Path
import subprocess
from typing import Any, TypeVar

from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.domains.mock_exams.deterministic_parser import (
    extract_jlpt_question_blocks,
    source_text_for_prompt,
)
from cert_prep_backend.domains.mock_exams.fastflowlm_client import FastFlowLMClient
from cert_prep_backend.domains.mock_exams.fastflowlm_resolver import (
    resolve_fastflowlm_executable,
)
from cert_prep_backend.domains.mock_exams.fastflowlm_server import (
    FastFlowLMServerManager,
    start_fastflowlm_server_process,
)
from cert_prep_backend.domains.mock_exams.model_fallback import ModelFallbackEngine
from cert_prep_backend.domains.mock_exams.models import (
    AnswerKeySource,
    DraftSuggestion,
    SourceChunk,
)
from cert_prep_backend.domains.mock_exams.normalization import dedupe_suggestions
from cert_prep_backend.domains.mock_exams.ports import ModelPullProgress, ProviderHealth
from cert_prep_backend.domains.mock_exams.reasoning_parser import (
    EXAM_ITEMS_SCHEMA,
    draft_suggestion_from_item,
)
from cert_prep_backend.domains.mock_exams.response_parsing import (
    answer_from_payload,
    confidence_from_payload,
    fast_first_prompt,
    is_non_fatal_generation_error as is_non_fatal_llm_generation_error,
    short_error,
    short_error_text,
)
from cert_prep_backend.domains.mock_exams.system_probes import available_system_ram_bytes


DEFAULT_FASTFLOWLM_BASE_URL = "http://127.0.0.1:52625/v1"
DEFAULT_FASTFLOWLM_PRIMARY_MODEL = "qwen3.5:4b"
FASTFLOWLM_RAM_FALLBACK_MODEL = "qwen3.5:2b"
DEFAULT_FASTFLOWLM_PRIMARY_MIN_AVAILABLE_RAM_BYTES = 6 * 1024 * 1024 * 1024
DEFAULT_FASTFLOWLM_AUTO_START_SERVER = True
DEFAULT_FASTFLOWLM_SERVER_START_TIMEOUT_SECONDS = 90.0
DEFAULT_FASTFLOWLM_OWNED_SERVER_IDLE_TIMEOUT_SECONDS = 5.0
FASTFLOWLM_MODEL_RETRY_AFTER_SECONDS = 300.0
T = TypeVar("T")


class FastFlowLMProvider:
    """FastFlowLM-backed mock exam draft provider using its OpenAI-compatible API."""

    provider = "fastflowlm"

    def __init__(
        self,
        base_url: str,
        model: str,
        timeout_seconds: float,
        fallback_models: Sequence[str] = (),
        model_pull_timeout_seconds: float | None = None,
        primary_min_available_ram_bytes: int = (DEFAULT_FASTFLOWLM_PRIMARY_MIN_AVAILABLE_RAM_BYTES),
        auto_start_server: bool = DEFAULT_FASTFLOWLM_AUTO_START_SERVER,
        server_start_timeout_seconds: float = (DEFAULT_FASTFLOWLM_SERVER_START_TIMEOUT_SECONDS),
        owned_server_idle_timeout_seconds: float = (
            DEFAULT_FASTFLOWLM_OWNED_SERVER_IDLE_TIMEOUT_SECONDS
        ),
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
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
            executable_resolver=lambda: resolve_fastflowlm_executable(),
            start_process=self._start_owned_server_process,
            served_model_names=self._served_model_names,
            model_to_serve=self._model_to_serve_for_auto_start,
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
            executable = resolve_fastflowlm_executable()
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

    def prewarm(self) -> None:
        """Send a tiny request to the already-running FastFlowLM server."""

        health = self.health()
        if not health.available or not health.effective_model:
            return

        try:
            self._with_model_fallback(
                lambda model: self._chat_content(
                    model,
                    [{"role": "user", "content": "Reply with ok."}],
                    max_tokens=1,
                    context_tokens=512,
                )
            )
        except ProviderUnavailableError:
            return

    def generate_fast_first_draft(
        self,
        source_chunk: SourceChunk,
        candidate: DraftSuggestion,
        *,
        num_ctx: int = 1024,
        num_predict: int = 128,
    ) -> DraftSuggestion | None:
        """Ask FastFlowLM to complete one extracted draft with answer/rationale JSON."""

        try:
            payload = self._with_model_fallback(
                lambda model: self._chat_json(
                    model,
                    [{"role": "user", "content": fast_first_prompt(candidate)}],
                    max_tokens=num_predict,
                    context_tokens=num_ctx,
                )
            )
        except ProviderUnavailableError as exc:
            if _is_non_fatal_fastflowlm_generation_error(exc):
                return None
            raise
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

        executable = resolve_fastflowlm_executable()
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
            creationflags=creationflags,
        )
        if completed.returncode != 0:
            output = (completed.stderr or completed.stdout or "").strip()
            raise ProviderUnavailableError(output or "FastFlowLM model pull failed.")
        progress(ModelPullProgress(status="success", completed=100, total=100))

    def release_resources(self) -> None:
        """Release any FastFlowLM server process owned by this provider after idle."""

        self._server_manager.release_resources()

    def close(self) -> None:
        """Stop the FastFlowLM server process when this provider started it."""

        self._server_manager.close()

    def _health_from_model_names(self, model_names: set[str]) -> ProviderHealth:
        effective_model = self._effective_model_from(model_names)

        # RAM-aware override: report the fallback model when primary is
        # blocked by low system RAM, without mutating the fallback engine
        # (mutation is deferred to actual generation in
        # _available_model_candidates).
        if effective_model == self.model and self._is_primary_ram_blocked():
            for fb in self.fallback_models:
                if fb in model_names:
                    effective_model = fb
                    break

        available = effective_model is not None
        fallback_reason = self._fallback_reason(effective_model)
        if (
            effective_model is not None
            and effective_model != self.model
            and self._is_primary_ram_blocked()
        ):
            fallback_reason = self._ram_blocked_fallback_reason(effective_model)

        return ProviderHealth(
            provider=self.provider,
            model=self.model,
            available=available,
            detail=self._health_detail(effective_model),
            unavailable_reason=None if available else "model_missing",
            configured_model=self.model,
            effective_model=effective_model,
            fallback_models=self.fallback_models,
            fallback_reason=fallback_reason,
        )

    def _served_model_names(self) -> set[str]:
        return self._client.served_model_names(request_json=self._request_json)

    def _available_model_candidates(self) -> tuple[str, ...]:
        self._refresh_primary_ram_state()
        try:
            model_names = self._served_model_names_for_generation()
        except Exception as exc:
            raise ProviderUnavailableError(f"FastFlowLM unavailable: {exc}") from exc

        candidates = self._fallback_engine.available_model_candidates(model_names)
        if candidates:
            return candidates

        health = self.health()
        raise ProviderUnavailableError(health.detail)

    def _effective_model_from(self, model_names: set[str]) -> str | None:
        return self._fallback_engine.effective_model_from(model_names)

    def _fallback_reason(self, effective_model: str | None) -> str | None:
        return self._fallback_engine.fallback_reason(
            effective_model,
            include_primary_failure=True,
        )

    def _health_detail(self, effective_model: str | None) -> str:
        if effective_model is None:
            primary_failure = self._primary_failure_reason()
            if primary_failure:
                return (
                    f"{short_error_text(primary_failure)}; fallback model "
                    f"{FASTFLOWLM_RAM_FALLBACK_MODEL} is not served."
                )
            return "model not found"
        if effective_model == self.model:
            return "model available"
        return f"model available via fallback {effective_model}"

    def _with_model_fallback(self, operation: Callable[[str], T]) -> T:
        self._server_manager.begin_generation_request()
        try:
            errors: list[str] = []
            for model in self._available_model_candidates():
                try:
                    result = operation(model)
                except Exception as exc:
                    if _is_transient_fastflowlm_generation_error(exc):
                        raise ProviderUnavailableError(
                            f"FastFlowLM transient generation error for {model}: {short_error(exc)}"
                        ) from exc
                    errors.append(f"{model}: {short_error(exc)}")
                    if not _is_non_fatal_fastflowlm_generation_error(exc):
                        self._mark_model_unusable(model, exc)
                    continue

                self._record_model_success(model)
                return result

            detail = "FastFlowLM unavailable for configured and fallback models"
            if errors:
                detail = f"{detail}: {'; '.join(errors)}"
            raise ProviderUnavailableError(detail)
        finally:
            self._server_manager.end_generation_request()

    def _served_model_names_for_generation(self) -> set[str]:
        try:
            return self._served_model_names()
        except Exception as exc:
            return self._server_manager.served_model_names_for_generation(exc)

    def _start_owned_server_process(
        self,
        *,
        executable: Path,
        model: str,
        host: str,
        port: int,
        creationflags: int,
    ) -> subprocess.Popen:
        return start_fastflowlm_server_process(
            executable=executable,
            model=model,
            host=host,
            port=port,
            creationflags=creationflags,
        )

    def _model_to_serve_for_auto_start(self) -> str:
        unusable_models = self._runtime_unusable_models()
        for candidate in (self.model, *self.fallback_models):
            if candidate not in unusable_models:
                return candidate
        return self.model

    def _chat_json(
        self,
        model: str,
        messages: Sequence[dict[str, str]],
        *,
        max_tokens: int,
        context_tokens: int,
    ) -> dict[str, Any]:
        return self._client.chat_json(
            model,
            messages,
            max_tokens=max_tokens,
            context_tokens=context_tokens,
            request_json=self._request_json,
        )

    def _chat_content(
        self,
        model: str,
        messages: Sequence[dict[str, str]],
        *,
        max_tokens: int,
        context_tokens: int,
        json_mode: bool = False,
    ) -> str:
        return self._client.chat_content(
            model,
            messages,
            max_tokens=max_tokens,
            context_tokens=context_tokens,
            json_mode=json_mode,
            request_json=self._request_json,
        )

    def _request_json(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        return self._client.request_json(
            method,
            path,
            body=body,
            timeout_seconds=timeout_seconds,
        )

    def _mark_model_unusable(self, model: str, exc: Exception) -> None:
        self._fallback_engine.mark_model_unusable(model, exc)

    def _record_model_success(self, model: str) -> None:
        self._fallback_engine.record_model_success(model)

    def _runtime_unusable_models(self) -> set[str]:
        return self._fallback_engine.runtime_unusable_models()

    def _primary_failure_reason(self) -> str | None:
        return self._fallback_engine.primary_failure_reason()

    def _is_primary_ram_blocked(self) -> bool:
        """Return True when primary model cannot run due to low system RAM.

        Read-only: does not mutate the fallback engine.
        """

        if not self._should_guard_primary_ram():
            return False
        available_ram = available_system_ram_bytes()
        if available_ram is None:
            return False
        return available_ram < self.primary_min_available_ram_bytes

    def _ram_blocked_fallback_reason(self, effective_model: str) -> str:
        available_ram = available_system_ram_bytes()
        return (
            f"Available system RAM {_format_gib(available_ram or 0)} is below the "
            f"{_format_gib(self.primary_min_available_ram_bytes)} required for "
            f"{self.model}; using fallback {effective_model}."
        )

    def _refresh_primary_ram_state(self) -> None:
        if not self._should_guard_primary_ram():
            return
        available_ram = available_system_ram_bytes()
        if available_ram is None:
            return
        if available_ram < self.primary_min_available_ram_bytes:
            self._mark_primary_blocked_by_ram(available_ram)
            return
        self._clear_primary_ram_block()

    def _should_guard_primary_ram(self) -> bool:
        return (
            self.primary_min_available_ram_bytes > 0
            and self.model == DEFAULT_FASTFLOWLM_PRIMARY_MODEL
            and FASTFLOWLM_RAM_FALLBACK_MODEL in self.fallback_models
        )

    def _mark_primary_blocked_by_ram(self, available_ram: int) -> None:
        reason = (
            f"Available system RAM {_format_gib(available_ram)} is below the "
            f"{_format_gib(self.primary_min_available_ram_bytes)} required for "
            f"{self.model}; trying fallback {FASTFLOWLM_RAM_FALLBACK_MODEL}"
        )
        self._fallback_engine.mark_primary_blocked(reason)

    def _clear_primary_ram_block(self) -> None:
        self._fallback_engine.clear_primary_block()


def _is_non_fatal_fastflowlm_generation_error(exc: Exception) -> bool:
    return is_non_fatal_llm_generation_error(exc) or _is_transient_fastflowlm_generation_error(exc)


def _is_transient_fastflowlm_generation_error(exc: Exception) -> bool:
    error = short_error(exc).lower()
    return any(
        marker in error
        for marker in (
            "timed out",
            "timeout",
            "client disconnected",
            "cancelled",
        )
    )


def _format_gib(value: int) -> str:
    return f"{value / (1024**3):.1f} GiB"
