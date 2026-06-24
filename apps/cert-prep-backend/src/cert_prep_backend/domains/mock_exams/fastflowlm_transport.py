from __future__ import annotations

from collections.abc import Callable, Sequence
import json
import os
from pathlib import Path
import shutil
import subprocess
from threading import Lock
from typing import Any, TypeVar
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.domains.mock_exams.deterministic_parser import (
    extract_jlpt_question_blocks,
    source_text_for_prompt,
)
from cert_prep_backend.domains.mock_exams.models import (
    AnswerKeySource,
    DraftSuggestion,
    SourceChunk,
)
from cert_prep_backend.domains.mock_exams.normalization import dedupe_suggestions
from cert_prep_backend.domains.mock_exams.ollama_transport import (
    _answer_from_payload,
    _confidence_from_payload,
    _fast_first_prompt,
    _is_non_fatal_generation_error as _is_non_fatal_llm_generation_error,
    _short_error_text,
)
from cert_prep_backend.domains.mock_exams.ports import ModelPullProgress, ProviderHealth
from cert_prep_backend.domains.mock_exams.reasoning_parser import (
    EXAM_ITEMS_SCHEMA,
    draft_suggestion_from_item,
)


DEFAULT_FASTFLOWLM_BASE_URL = "http://127.0.0.1:52625/v1"
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
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout_seconds = timeout_seconds
        self.model_pull_timeout_seconds = model_pull_timeout_seconds or timeout_seconds
        self.fallback_models = tuple(
            dict.fromkeys(
                fallback.strip()
                for fallback in fallback_models
                if fallback.strip() and fallback.strip() != model
            )
        )
        self._model_lock = Lock()
        self._unusable_models: set[str] = set()
        self._runtime_effective_model: str | None = None
        self._last_primary_failure: str | None = None
        self._runtime_fallback_reason: str | None = None

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
                detail = (
                    f"FastFlowLM server unavailable at {self.base_url}: "
                    f"{_short_error(exc)}"
                )
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
                    [{"role": "user", "content": _fast_first_prompt(candidate)}],
                    max_tokens=num_predict,
                    context_tokens=num_ctx,
                )
            )
        except ProviderUnavailableError as exc:
            if _is_non_fatal_fastflowlm_generation_error(exc):
                return None
            raise
        answer = _answer_from_payload(payload.get("answer"), candidate.choices)
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
            confidence=_confidence_from_payload(payload.get("confidence")),
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

    def _health_from_model_names(self, model_names: set[str]) -> ProviderHealth:
        effective_model = self._effective_model_from(model_names)
        available = effective_model is not None
        fallback_reason = self._fallback_reason(effective_model)
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
        return extract_openai_model_names(
            self._request_json("GET", "/models", timeout_seconds=min(5.0, self.timeout_seconds))
        )

    def _available_model_candidates(self) -> tuple[str, ...]:
        try:
            model_names = self._served_model_names()
        except Exception as exc:
            raise ProviderUnavailableError(f"FastFlowLM unavailable: {exc}") from exc

        unusable_models = self._runtime_unusable_models()
        candidates = tuple(
            candidate
            for candidate in (self.model, *self.fallback_models)
            if candidate in model_names and candidate not in unusable_models
        )
        if candidates:
            return candidates

        health = self.health()
        raise ProviderUnavailableError(health.detail)

    def _effective_model_from(self, model_names: set[str]) -> str | None:
        unusable_models = self._runtime_unusable_models()
        runtime_effective_model = self._runtime_selected_model()
        if (
            runtime_effective_model
            and runtime_effective_model in model_names
            and runtime_effective_model not in unusable_models
        ):
            return runtime_effective_model
        for candidate in (self.model, *self.fallback_models):
            if candidate in unusable_models:
                continue
            if candidate in model_names:
                return candidate
        return None

    def _fallback_reason(self, effective_model: str | None) -> str | None:
        if effective_model is None or effective_model == self.model:
            return None
        runtime_reason = self._runtime_reason_for(effective_model)
        if runtime_reason:
            return runtime_reason
        return f"Configured model {self.model} is missing; using fallback {effective_model}."

    def _health_detail(self, effective_model: str | None) -> str:
        if effective_model is None:
            return "model not found"
        if effective_model == self.model:
            return "model available"
        return f"model available via fallback {effective_model}"

    def _with_model_fallback(self, operation: Callable[[str], T]) -> T:
        errors: list[str] = []
        for model in self._available_model_candidates():
            try:
                result = operation(model)
            except Exception as exc:
                if _is_transient_fastflowlm_generation_error(exc):
                    raise ProviderUnavailableError(
                        f"FastFlowLM transient generation error for {model}: {_short_error(exc)}"
                    ) from exc
                errors.append(f"{model}: {_short_error(exc)}")
                if not _is_non_fatal_fastflowlm_generation_error(exc):
                    self._mark_model_unusable(model, exc)
                continue

            self._record_model_success(model)
            return result

        detail = "FastFlowLM unavailable for configured and fallback models"
        if errors:
            detail = f"{detail}: {'; '.join(errors)}"
        raise ProviderUnavailableError(detail)

    def _chat_json(
        self,
        model: str,
        messages: Sequence[dict[str, str]],
        *,
        max_tokens: int,
        context_tokens: int,
    ) -> dict[str, Any]:
        content = self._chat_content(
            model,
            messages,
            max_tokens=max_tokens,
            context_tokens=context_tokens,
            json_mode=True,
        )
        try:
            payload = json.loads(content)
        except json.JSONDecodeError as exc:
            raise ProviderUnavailableError("FastFlowLM returned invalid JSON.") from exc
        if not isinstance(payload, dict):
            raise ProviderUnavailableError("FastFlowLM returned a non-object JSON response.")
        return payload

    def _chat_content(
        self,
        model: str,
        messages: Sequence[dict[str, str]],
        *,
        max_tokens: int,
        context_tokens: int,
        json_mode: bool = False,
    ) -> str:
        request = {
            "model": model,
            "messages": list(messages),
            "temperature": 0,
            "max_tokens": max_tokens,
            "stream": False,
            "extra_body": {"num_ctx": context_tokens},
        }
        if json_mode:
            request["response_format"] = {"type": "json_object"}
        try:
            response = self._request_json("POST", "/chat/completions", body=request)
        except ProviderUnavailableError as exc:
            if json_mode and "response_format" in str(exc).lower():
                request.pop("response_format", None)
                response = self._request_json("POST", "/chat/completions", body=request)
            else:
                raise
        content = _chat_completion_content(response)
        if content is None:
            raise ProviderUnavailableError("FastFlowLM returned an unreadable response.")
        return content

    def _request_json(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
            headers["Authorization"] = "Bearer flm"
        request = Request(
            f"{self.base_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urlopen(request, timeout=timeout_seconds or self.timeout_seconds) as response:
                payload = response.read().decode("utf-8")
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace").strip()
            raise ProviderUnavailableError(
                f"FastFlowLM HTTP {exc.code}: {detail or exc.reason}"
            ) from exc
        except (OSError, URLError, ValueError) as exc:
            raise ProviderUnavailableError(str(exc)) from exc
        try:
            decoded = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise ProviderUnavailableError("FastFlowLM returned invalid response JSON.") from exc
        if not isinstance(decoded, dict):
            raise ProviderUnavailableError("FastFlowLM returned non-object response JSON.")
        return decoded

    def _mark_model_unusable(self, model: str, exc: Exception) -> None:
        with self._model_lock:
            self._unusable_models.add(model)
            if model == self.model:
                self._last_primary_failure = _short_error(exc)
            if self._runtime_effective_model == model:
                self._runtime_effective_model = None
                self._runtime_fallback_reason = None

    def _record_model_success(self, model: str) -> None:
        with self._model_lock:
            if model == self.model:
                self._runtime_effective_model = None
                self._runtime_fallback_reason = None
                return

            self._runtime_effective_model = model
            if self._last_primary_failure:
                self._runtime_fallback_reason = (
                    f"Configured model {self.model} was unavailable during generation "
                    f"({_short_error_text(self._last_primary_failure)}); using fallback {model}."
                )
            else:
                self._runtime_fallback_reason = (
                    f"Configured model {self.model} is missing; using fallback {model}."
                )

    def _runtime_unusable_models(self) -> set[str]:
        with self._model_lock:
            return set(self._unusable_models)

    def _runtime_selected_model(self) -> str | None:
        with self._model_lock:
            return self._runtime_effective_model

    def _runtime_reason_for(self, effective_model: str) -> str | None:
        with self._model_lock:
            if self._runtime_effective_model != effective_model:
                return None
            return self._runtime_fallback_reason


def resolve_fastflowlm_executable() -> Path | None:
    """Resolve the FastFlowLM CLI from PATH or common Windows install paths."""

    configured = shutil.which("flm")
    if configured:
        return Path(configured)
    if os.name != "nt":
        return None

    candidates: list[Path] = []
    for root in (
        os.environ.get("LOCALAPPDATA"),
        os.environ.get("ProgramFiles"),
        os.environ.get("ProgramFiles(x86)"),
    ):
        if not root:
            continue
        base = Path(root)
        candidates.extend(
            [
                base / "Programs" / "FastFlowLM" / "flm.exe",
                base / "flm" / "flm.exe",
                base / "flm" / "bin" / "flm.exe",
                base / "FastFlowLM" / "flm.exe",
                base / "FastFlowLM" / "bin" / "flm.exe",
            ]
        )
    return next((candidate for candidate in candidates if candidate.is_file()), None)


def extract_openai_model_names(response: Any) -> set[str]:
    """Extract model identifiers from OpenAI-compatible model-list responses."""

    names: set[str] = set()
    model_items = []
    if isinstance(response, dict):
        if isinstance(response.get("data"), list):
            model_items.extend(response["data"])
        if isinstance(response.get("models"), list):
            model_items.extend(response["models"])
    for item in model_items:
        if isinstance(item, str):
            names.add(item)
            continue
        if not isinstance(item, dict):
            continue
        for key in ("id", "model", "name"):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                names.add(value.strip())
                break
    return names


def _chat_completion_content(response: dict[str, Any]) -> str | None:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    first = choices[0]
    if not isinstance(first, dict):
        return None
    message = first.get("message")
    if isinstance(message, dict) and isinstance(message.get("content"), str):
        return message["content"]
    if isinstance(first.get("text"), str):
        return first["text"]
    return None


def _is_non_fatal_fastflowlm_generation_error(exc: Exception) -> bool:
    return _is_non_fatal_llm_generation_error(
        exc
    ) or _is_transient_fastflowlm_generation_error(exc)


def _is_transient_fastflowlm_generation_error(exc: Exception) -> bool:
    error = _short_error(exc).lower()
    return any(
        marker in error
        for marker in (
            "timed out",
            "timeout",
            "client disconnected",
            "cancelled",
        )
    )


def _short_error(exc: Exception) -> str:
    return _short_error_text(str(exc) or exc.__class__.__name__)
