from collections.abc import Sequence
from pathlib import Path
from threading import Event

import pytest
from fastapi.testclient import TestClient

from exam_prep_backend.app import create_app
from exam_prep_backend.config import DEFAULT_OLLAMA_MODEL, Settings
from exam_prep_backend.domains.mock_exams.models import DraftSuggestion, SourceChunk
from exam_prep_backend.domains.mock_exams.ports import ModelPullProgress, ProviderHealth
from exam_prep_backend.domains.mock_exams.ollama_transport import OllamaProvider
from exam_prep_backend.domains.mock_exams import ollama_transport
from exam_prep_backend.domains.mock_exams.provider import (
    MAX_PROMPT_SOURCE_CHARS,
    _draft_suggestion_from_item,
    _extract_jlpt_question_blocks,
    _json_response,
    _source_text_for_prompt,
)
from exam_prep_backend.errors import ProviderUnavailableError


AUTH_HEADERS = {"Authorization": "Bearer test-token"}


def test_draft_parser_rejects_cover_and_instruction_text_as_exam_items() -> None:
    rejected_texts = [
        "This test paper has multiple versions with the same question content.",
        "General instructions: do not open this booklet until you are told to start.",
    ]

    for rejected_text in rejected_texts:
        _assert_rejected_as_non_exam_item(rejected_text)


def test_draft_parser_accepts_jlpt_like_choice_item() -> None:
    chunk = SourceChunk(
        id="chunk-2",
        page_number=3,
        text=(
            "Mondai 1 Choose the correct reading. "
            "1 seikai 2 gotou 3 betsu 4 hoka"
        ),
        source_excerpt="Mondai 1 Choose the correct reading.",
    )

    suggestion = _draft_suggestion_from_item(
        {
            "chunk_id": "chunk-2",
            "citation_page": 3,
            "question": "Mondai 1 Choose the correct reading.",
            "choices": ["1 seikai", "2 gotou", "3 betsu", "4 hoka"],
            "answer": "1",
            "answer_key_source": "ai_inferred",
            "rationale": "Choice 1 matches the inferred reading.",
            "source_excerpt": "Mondai 1 Choose the correct reading.",
            "confidence": 0.82,
        },
        {3: chunk},
        {"chunk-2": chunk},
    )

    assert suggestion is not None
    assert suggestion.answer == "1 seikai"
    assert suggestion.citation_page == 3
    assert suggestion.confidence == 0.82


def test_draft_parser_rejects_invalid_json_and_grounding_mismatches() -> None:
    chunk = SourceChunk(
        id="chunk-2",
        page_number=3,
        text="Mondai 1 Choose the correct reading. 1 seikai 2 gotou 3 betsu 4 hoka",
        source_excerpt="Mondai 1 Choose the correct reading.",
    )
    valid_item = {
        "chunk_id": "chunk-2",
        "citation_page": 3,
        "question": "Mondai 1 Choose the correct reading.",
        "choices": ["1 seikai", "2 gotou", "3 betsu", "4 hoka"],
        "answer": "1",
        "answer_key_source": "ai_inferred",
        "rationale": "Choice 1 matches the inferred reading.",
        "source_excerpt": "Mondai 1 Choose the correct reading.",
        "confidence": 0.82,
    }

    with pytest.raises(ProviderUnavailableError, match="invalid JSON"):
        _json_response({"message": {"content": "not-json"}})
    assert (
        _draft_suggestion_from_item(
            valid_item | {"citation_page": 99},
            {3: chunk},
            {"chunk-2": chunk},
        )
        is None
    )
    assert (
        _draft_suggestion_from_item(
            valid_item | {"source_excerpt": "not in source"},
            {3: chunk},
            {"chunk-2": chunk},
        )
        is None
    )
    assert (
        _draft_suggestion_from_item(
            valid_item | {"answer": "missing choice"},
            {3: chunk},
            {"chunk-2": chunk},
        )
        is None
    )


def test_ollama_prompt_source_skips_notice_pages_and_stays_bounded() -> None:
    notice = SourceChunk(
        id="cover",
        page_number=1,
        text=(
            "This test paper has multiple versions. The questions are the same, "
            "but the fonts and layouts differ."
        ),
        source_excerpt="This test paper has multiple versions.",
    )
    first_exam_page = SourceChunk(
        id="page-2",
        page_number=2,
        text=(
            "問題1 の言葉の読み方として最もよいのを、1・2・3・4から"
            "一つ選びなさい。 1 余暇の楽しみ方はいろいろある。"
            " 1 ようか 2 よか 3 よが 4 ようが"
        ),
        source_excerpt="問題1 の言葉の読み方として最もよいのを選びなさい。",
    )
    long_exam_page = SourceChunk(
        id="page-3",
        page_number=3,
        text="問題2 " + ("日本語の設問 " * 2000),
        source_excerpt="問題2",
    )

    source = _source_text_for_prompt([notice, first_exam_page, long_exam_page], limit=3)

    assert "chunk_id:cover" not in source
    assert "chunk_id:page-2" in source
    assert "余暇" in source
    assert len(source) <= MAX_PROMPT_SOURCE_CHARS


def test_jlpt_question_blocks_extract_as_unanswered_candidates_without_ai() -> None:
    chunk = SourceChunk(
        id="page-2",
        page_number=2,
        text=(
            "問題1 の言葉の読み方として最もよいのを、1・2・3・4から"
            "一つ選びなさい。 1 余暇の楽しみ方はいろいろある。 "
            "1 ようか 2 よか 3 よが 4 ようが "
            "2 その動物は動きが鈍い。 1 するどい 2 にぶい 3 あらい 4 あやうい"
        ),
        source_excerpt="問題1 の言葉の読み方として最もよいのを選びなさい。",
    )

    suggestions = _extract_jlpt_question_blocks([chunk], limit=2)

    assert len(suggestions) == 2
    assert suggestions[0].question == "余暇の楽しみ方はいろいろある。"
    assert suggestions[0].choices == ("1 ようか", "2 よか", "3 よが", "4 ようが")
    assert suggestions[0].answer == ""
    assert suggestions[0].answer_key_source.value == "manual"
    assert suggestions[0].status.value == "approved"
    assert suggestions[0].citation_page == 2
    assert suggestions[0].confidence == 1.0
    assert suggestions[0].source_order == 20001
    assert suggestions[0].source_question_number == "1"
    assert suggestions[0].item_kind.value == "vocabulary_single"
    assert suggestions[0].group_key is None


def test_llm_health_does_not_pull_missing_ollama_model(tmp_path) -> None:
    provider = RecordingDownloadProvider(available=False, detail="model not found")
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            llm_provider=provider,
            runtime_installation_async_jobs=False,
        )
    )

    response = client.get("/llm/health", headers=AUTH_HEADERS)

    assert response.status_code == 200
    assert response.json()["detail"] == "model not found"
    assert provider.pull_calls == 0


def test_settings_parse_comma_separated_ollama_fallback_models(tmp_path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        ollama_fallback_models="qwen3:8b, gemma4:12b, ",
    )

    assert settings.ollama_fallback_models == ["qwen3:8b", "gemma4:12b"]


def test_settings_parse_env_ollama_fallback_models(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("EXAM_PREP_DATA_DIR", str(tmp_path))
    monkeypatch.setenv(
        "EXAM_PREP_OLLAMA_FALLBACK_MODELS",
        "qwen3:8b, gemma4:12b, ",
    )

    settings = Settings()

    assert settings.ollama_fallback_models == ["qwen3:8b", "gemma4:12b"]


def test_ollama_health_uses_installed_fallback_without_pull(monkeypatch) -> None:
    fake_client = RecordingOllamaClient(models=["qwen3:8b"])
    monkeypatch.setattr(
        ollama_transport, "resolve_ollama_executable", lambda: Path("ollama")
    )
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3:14b",
        timeout_seconds=1,
        fallback_models=["qwen3:8b"],
    )
    provider._client = fake_client

    health = provider.health()

    assert health.available is True
    assert health.model == "qwen3:14b"
    assert health.configured_model == "qwen3:14b"
    assert health.effective_model == "qwen3:8b"
    assert health.fallback_models == ("qwen3:8b",)
    assert (
        health.fallback_reason
        == "Configured model qwen3:14b is missing; using fallback qwen3:8b."
    )
    assert health.unavailable_reason is None
    assert fake_client.chat_calls == []
    assert fake_client.pull_calls == 0


def test_ollama_health_uses_http_api_when_cli_is_not_on_path(monkeypatch) -> None:
    fake_client = RecordingOllamaClient(models=["qwen3:8b"])
    monkeypatch.setattr(ollama_transport, "resolve_ollama_executable", lambda: None)
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3:14b",
        timeout_seconds=1,
        fallback_models=["qwen3:8b"],
    )
    provider._client = fake_client

    health = provider.health()

    assert health.available is True
    assert health.effective_model == "qwen3:8b"
    assert health.fallback_reason is not None
    assert "using fallback qwen3:8b" in health.fallback_reason
    assert fake_client.pull_calls == 0


def test_ollama_prewarm_only_chats_when_configured_model_exists(monkeypatch) -> None:
    fake_client = RecordingOllamaClient(models=["qwen3:14b"])
    monkeypatch.setattr(ollama_transport, "resolve_ollama_executable", lambda: Path("ollama"))
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3:14b",
        timeout_seconds=1,
    )
    provider._client = fake_client

    provider.prewarm()

    assert fake_client.chat_calls == [
        {
            "model": "qwen3:14b",
            "messages": [{"role": "user", "content": "Reply with ok."}],
            "options": {"temperature": 0, "num_ctx": 512, "num_predict": 1},
            "think": False,
            "keep_alive": "5m",
        }
    ]
    assert fake_client.pull_calls == 0


def test_ollama_prewarm_skips_missing_model_without_pull(monkeypatch) -> None:
    fake_client = RecordingOllamaClient(models=[])
    monkeypatch.setattr(ollama_transport, "resolve_ollama_executable", lambda: Path("ollama"))
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3:14b",
        timeout_seconds=1,
    )
    provider._client = fake_client

    provider.prewarm()

    assert fake_client.chat_calls == []
    assert fake_client.pull_calls == 0


def test_ollama_prewarm_uses_available_fallback_model(monkeypatch) -> None:
    fake_client = RecordingOllamaClient(models=["qwen3:8b"])
    monkeypatch.setattr(
        ollama_transport, "resolve_ollama_executable", lambda: Path("ollama")
    )
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3:14b",
        timeout_seconds=1,
        fallback_models=["qwen3:8b"],
    )
    provider._client = fake_client

    provider.prewarm()

    assert fake_client.chat_calls[0]["model"] == "qwen3:8b"
    assert fake_client.pull_calls == 0


def test_ollama_prewarm_falls_back_when_primary_runtime_fails(monkeypatch) -> None:
    fake_client = RecordingOllamaClient(
        models=["qwen3:14b", "qwen3:8b"],
        fail_models={"qwen3:14b": RuntimeError("model requires more memory")},
    )
    monkeypatch.setattr(
        ollama_transport, "resolve_ollama_executable", lambda: Path("ollama")
    )
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3:14b",
        timeout_seconds=1,
        fallback_models=["qwen3:8b"],
    )
    provider._client = fake_client

    provider.prewarm()

    assert [call["model"] for call in fake_client.chat_calls] == [
        "qwen3:14b",
        "qwen3:8b",
    ]
    health = provider.health()
    assert health.effective_model == "qwen3:8b"
    assert health.fallback_reason is not None
    assert "unavailable during generation" in health.fallback_reason
    assert fake_client.pull_calls == 0


def test_ollama_fast_first_draft_maps_compact_json_to_candidate_choice(
    monkeypatch,
) -> None:
    fake_client = RecordingOllamaClient(
        models=["qwen3:14b"],
        chat_content='{"answer":"2","rationale":"Qwen picked the closest reading.","confidence":"high"}',
    )
    monkeypatch.setattr(ollama_transport, "resolve_ollama_executable", lambda: Path("ollama"))
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3:14b",
        timeout_seconds=1,
    )
    provider._client = fake_client
    chunk = SourceChunk(
        id="chunk-2",
        page_number=2,
        text="1 余暇の楽しみ方はいろいろある。 1 ようか 2よか 3よが 4 ようが",
        source_excerpt="1 余暇の楽しみ方はいろいろある。",
    )
    candidate = DraftSuggestion(
        chunk_id=chunk.id,
        question="余暇の楽しみ方はいろいろある。",
        choices=["1 ようか", "2 よか", "3 よが", "4 ようが"],
        answer="",
        answer_key_source="manual",
        rationale="",
        citation_page=2,
        source_excerpt="1 余暇の楽しみ方はいろいろある。",
    )

    suggestion = provider.generate_fast_first_draft(chunk, candidate)

    assert suggestion is not None
    assert suggestion.answer == "2 よか"
    assert suggestion.answer_key_source.value == "ai_inferred"
    assert suggestion.rationale == "Qwen picked the closest reading."
    assert suggestion.confidence == 0.8
    assert fake_client.chat_calls[0]["format"] == "json"
    assert fake_client.pull_calls == 0


def test_ollama_fast_first_draft_falls_back_when_primary_runtime_fails(
    monkeypatch,
) -> None:
    fake_client = RecordingOllamaClient(
        models=["qwen3:14b", "qwen3:8b"],
        chat_content='{"answer":"2","rationale":"Fallback picked the answer.","confidence":0.72}',
        fail_models={"qwen3:14b": RuntimeError("model requires more memory")},
    )
    monkeypatch.setattr(
        ollama_transport, "resolve_ollama_executable", lambda: Path("ollama")
    )
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3:14b",
        timeout_seconds=1,
        fallback_models=["qwen3:8b"],
    )
    provider._client = fake_client
    chunk = SourceChunk(
        id="chunk-2",
        page_number=2,
        text="Question text. 1 first 2 second 3 third 4 fourth",
        source_excerpt="Question text.",
    )
    candidate = DraftSuggestion(
        chunk_id=chunk.id,
        question="Question text.",
        choices=["1 first", "2 second", "3 third", "4 fourth"],
        answer="",
        answer_key_source="manual",
        rationale="",
        citation_page=2,
        source_excerpt="Question text.",
    )

    suggestion = provider.generate_fast_first_draft(chunk, candidate)

    assert suggestion is not None
    assert suggestion.answer == "2 second"
    assert [call["model"] for call in fake_client.chat_calls] == [
        "qwen3:14b",
        "qwen3:8b",
    ]
    health = provider.health()
    assert health.effective_model == "qwen3:8b"
    assert health.fallback_reason is not None
    assert "model requires more memory" in health.fallback_reason
    assert fake_client.pull_calls == 0


def test_model_download_starts_only_from_explicit_post(tmp_path) -> None:
    provider = RecordingDownloadProvider(available=False, detail="model not found")
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            llm_provider=provider,
            runtime_installation_async_jobs=False,
        )
    )

    response = client.post("/llm/model-downloads", headers=AUTH_HEADERS)

    assert response.status_code == 202
    assert provider.pull_calls == 1
    assert response.json() == {
        "id": response.json()["id"],
        "provider": "ollama",
        "model": DEFAULT_OLLAMA_MODEL,
        "status": "succeeded",
        "detail": "model download complete",
        "completed": 100,
        "total": 100,
        "created_at": response.json()["created_at"],
        "updated_at": response.json()["updated_at"],
        "error": None,
    }


def test_model_download_poll_returns_job_status(tmp_path) -> None:
    provider = RecordingDownloadProvider(available=False, detail="model not found")
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            llm_provider=provider,
            runtime_installation_async_jobs=False,
        )
    )
    started = client.post("/llm/model-downloads", headers=AUTH_HEADERS).json()

    response = client.get(f"/llm/model-downloads/{started['id']}", headers=AUTH_HEADERS)

    assert response.status_code == 200
    assert response.json()["id"] == started["id"]
    assert response.json()["status"] == "succeeded"


def test_model_download_reuses_existing_running_job(tmp_path) -> None:
    release_pull = Event()
    provider = BlockingDownloadProvider(release_pull)
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            llm_provider=provider,
        )
    )

    first = client.post("/llm/model-downloads", headers=AUTH_HEADERS)
    second = client.post("/llm/model-downloads", headers=AUTH_HEADERS)
    release_pull.set()

    assert first.status_code == 202
    assert second.status_code == 202
    assert second.json()["id"] == first.json()["id"]
    assert provider.pull_calls == 1


def test_model_download_records_provider_failure(tmp_path) -> None:
    provider = FailingDownloadProvider()
    client = TestClient(
        create_app(
            settings=Settings(data_dir=tmp_path, api_token="test-token"),
            llm_provider=provider,
            runtime_installation_async_jobs=False,
        )
    )

    response = client.post("/llm/model-downloads", headers=AUTH_HEADERS)

    assert response.status_code == 202
    assert response.json()["status"] == "failed"
    assert response.json()["detail"] == "Ollama unavailable: connection refused"


def test_model_download_rejects_provider_without_pull_support(client, auth_headers) -> None:
    response = client.post("/llm/model-downloads", headers=auth_headers)

    assert response.status_code == 503
    assert response.json() == {
        "code": "provider_unavailable",
        "message": "Configured LLM provider does not support model downloads.",
    }


def _assert_rejected_as_non_exam_item(rejected_text: str) -> None:
    chunk = SourceChunk(
        id="chunk-1",
        page_number=1,
        text=f"2025 JLPT N1 notice. {rejected_text}",
        source_excerpt=rejected_text,
    )

    suggestion = _draft_suggestion_from_item(
        {
            "citation_page": 1,
            "question": rejected_text,
            "choices": [
                f"A. {rejected_text}",
                "B. The content is unchanged, but fonts and layout may differ.",
            ],
            "answer": "B",
            "answer_key_source": "ai_inferred",
            "rationale": "The notice says the content is the same.",
            "source_excerpt": rejected_text,
            "confidence": 0.7,
        },
        {1: chunk},
        {"chunk-1": chunk},
    )

    assert suggestion is None


class RecordingDownloadProvider:
    provider = "ollama"
    model = DEFAULT_OLLAMA_MODEL

    def __init__(self, *, available: bool, detail: str) -> None:
        self.available = available
        self.detail = detail
        self.pull_calls = 0

    def health(self) -> ProviderHealth:
        return ProviderHealth(
            provider=self.provider,
            model=self.model,
            available=self.available,
            detail=self.detail,
        )

    def generate_drafts(
        self, chunks: Sequence[SourceChunk], limit: int
    ) -> list[DraftSuggestion]:
        return []

    def pull_model(self, progress) -> None:
        self.pull_calls += 1
        progress(ModelPullProgress(status="pulling manifest"))
        progress(ModelPullProgress(status="downloading", completed=50, total=100))
        progress(ModelPullProgress(status="success", completed=100, total=100))


class RecordingOllamaClient:
    def __init__(
        self,
        *,
        models: list[str],
        chat_content: str = "ok",
        fail_models: dict[str, Exception] | None = None,
    ) -> None:
        self.models = models
        self.chat_content = chat_content
        self.fail_models = fail_models or {}
        self.chat_calls: list[dict] = []
        self.pull_calls = 0

    def list(self) -> dict:
        return {"models": [{"model": model} for model in self.models]}

    def chat(self, **kwargs) -> dict:
        self.chat_calls.append(kwargs)
        model = kwargs.get("model")
        if isinstance(model, str) and model in self.fail_models:
            raise self.fail_models[model]
        return {"message": {"content": self.chat_content}}

    def pull(self, *_args, **_kwargs):
        self.pull_calls += 1
        raise AssertionError("prewarm must not pull models")


class BlockingDownloadProvider(RecordingDownloadProvider):
    def __init__(self, release_pull: Event) -> None:
        super().__init__(available=False, detail="model not found")
        self._release_pull = release_pull

    def pull_model(self, progress) -> None:
        self.pull_calls += 1
        progress(ModelPullProgress(status="downloading", completed=1, total=100))
        self._release_pull.wait(timeout=5)
        progress(ModelPullProgress(status="success", completed=100, total=100))


class FailingDownloadProvider(RecordingDownloadProvider):
    def __init__(self) -> None:
        super().__init__(available=False, detail="model not found")

    def pull_model(self, progress) -> None:
        self.pull_calls += 1
        progress(ModelPullProgress(status="pulling manifest"))
        raise RuntimeError("connection refused")
