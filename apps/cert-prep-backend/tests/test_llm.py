import copy
from collections.abc import Sequence
from pathlib import Path
from threading import Event
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import (
    DEFAULT_FASTFLOWLM_MODEL,
    DEFAULT_OLLAMA_MODEL,
    Settings,
)
from cert_prep_backend.domains.mock_exams.fastflowlm_transport import FastFlowLMProvider
from cert_prep_backend.domains.mock_exams import fastflowlm_transport
from cert_prep_backend.domains.mock_exams.models import DraftSuggestion, SourceChunk
from cert_prep_backend.domains.mock_exams.ports import ModelPullProgress, ProviderHealth
from cert_prep_backend.domains.mock_exams.ollama_transport import OllamaProvider
from cert_prep_backend.domains.mock_exams import ollama_transport
from cert_prep_backend.domains.mock_exams.provider import (
    MAX_PROMPT_SOURCE_CHARS,
    _draft_suggestion_from_item,
    _extract_jlpt_question_blocks,
    _json_response,
    _source_text_for_prompt,
    provider_from_settings,
)
from cert_prep_backend.api.errors import ProviderUnavailableError


AUTH_HEADERS = {"Authorization": "Bearer test-token"}
GIB = 1024 * 1024 * 1024


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
        ollama_fallback_models="qwen3.5:2b, gemma4:12b, ",
    )

    assert settings.ollama_fallback_models == ["qwen3.5:2b", "gemma4:12b"]


def test_settings_parse_env_ollama_fallback_models(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("CERT_PREP_DATA_DIR", str(tmp_path))
    monkeypatch.setenv(
        "CERT_PREP_OLLAMA_FALLBACK_MODELS",
        "qwen3.5:2b, gemma4:12b, ",
    )

    settings = Settings()

    assert settings.ollama_fallback_models == ["qwen3.5:2b", "gemma4:12b"]


def test_settings_parse_comma_separated_fastflowlm_fallback_models(tmp_path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        fastflowlm_fallback_models="qwen3.5:2b, qwen3.5:0.8b, ",
    )

    assert settings.fastflowlm_fallback_models == ["qwen3.5:2b", "qwen3.5:0.8b"]


def test_provider_from_settings_can_select_fastflowlm(tmp_path) -> None:
    provider = provider_from_settings(
        Settings(
            data_dir=tmp_path,
            llm_provider="fastflowlm",
            fastflowlm_model="qwen3.5:4b",
            fastflowlm_fallback_models=["qwen3.5:2b"],
            fastflowlm_base_url="http://127.0.0.1:52625/v1/",
        )
    )

    assert isinstance(provider, FastFlowLMProvider)
    assert provider.provider == "fastflowlm"
    assert provider.model == "qwen3.5:4b"
    assert provider.fallback_models == ("qwen3.5:2b",)
    assert provider.base_url == "http://127.0.0.1:52625/v1"


def test_fastflowlm_health_reports_missing_runtime_without_model_download(monkeypatch) -> None:
    monkeypatch.setattr(fastflowlm_transport, "resolve_fastflowlm_executable", lambda: None)
    provider = FastFlowLMProvider(
        base_url="http://127.0.0.1:1/v1",
        model=DEFAULT_FASTFLOWLM_MODEL,
        timeout_seconds=0.05,
        fallback_models=["qwen3.5:2b"],
    )

    health = provider.health()

    assert health.available is False
    assert health.provider == "fastflowlm"
    assert health.model == DEFAULT_FASTFLOWLM_MODEL
    assert health.configured_model == DEFAULT_FASTFLOWLM_MODEL
    assert health.unavailable_reason == "fastflowlm_missing"
    assert health.fallback_models == ("qwen3.5:2b",)
    assert "FastFlowLM is not installed" in health.detail


def test_fastflowlm_executable_resolution_accepts_official_flm_install_dir(
    monkeypatch, tmp_path
) -> None:
    install_dir = tmp_path / "flm"
    install_dir.mkdir()
    executable = install_dir / "flm.exe"
    executable.write_text("", encoding="utf-8")
    monkeypatch.setattr(fastflowlm_transport.shutil, "which", lambda _: None)
    monkeypatch.setenv("ProgramFiles", str(tmp_path))
    monkeypatch.setenv("ProgramFiles(x86)", str(tmp_path / "x86"))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))

    assert fastflowlm_transport.resolve_fastflowlm_executable() == executable


def test_fastflowlm_pull_uses_runtime_install_timeout(monkeypatch, tmp_path) -> None:
    executable = tmp_path / "flm.exe"
    executable.write_text("", encoding="utf-8")
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        fastflowlm_transport,
        "resolve_fastflowlm_executable",
        lambda: executable,
    )

    def fake_run(*args, **kwargs):
        captured["args"] = args
        captured.update(kwargs)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(fastflowlm_transport.subprocess, "run", fake_run)
    provider = FastFlowLMProvider(
        base_url="http://127.0.0.1:52625/v1",
        model="qwen3.5:4b",
        timeout_seconds=5,
        model_pull_timeout_seconds=900,
    )

    provider.pull_model(lambda _progress: None)

    assert captured["timeout"] == 900
    assert captured["args"][0] == [str(executable), "pull", "qwen3.5:4b"]


def test_fastflowlm_health_uses_served_fallback_model() -> None:
    provider = RecordingFastFlowLMProvider(models=["qwen3.5:2b"])

    health = provider.health()

    assert health.available is True
    assert health.configured_model == "qwen3.5:4b"
    assert health.effective_model == "qwen3.5:2b"
    assert (
        health.fallback_reason
        == "Configured model qwen3.5:4b is missing; using fallback qwen3.5:2b."
    )
    assert provider.requests[0]["path"] == "/models"


def test_fastflowlm_reasoning_drafts_use_openai_compatible_chat() -> None:
    provider = RecordingFastFlowLMProvider(
        models=["qwen3.5:4b"],
        chat_content=(
            '{"items":[{"chunk_id":"chunk-1","citation_page":1,'
            '"question":"Mondai 1 Choose the correct reading.",'
            '"choices":["1 first","2 second","3 third","4 fourth"],'
            '"answer":"1 first","answer_key_source":"ai_inferred",'
            '"rationale":"The source supports choice 1.",'
            '"source_excerpt":"Mondai 1 Choose the correct reading.",'
            '"confidence":0.9}]}'
        ),
    )
    chunk = SourceChunk(
        id="chunk-1",
        page_number=1,
        text="Mondai 1 Choose the correct reading. 1 first 2 second 3 third 4 fourth",
        source_excerpt="Mondai 1 Choose the correct reading.",
    )

    suggestions = provider.generate_reasoning_drafts([chunk], limit=1)

    assert len(suggestions) == 1
    assert suggestions[0].question == "Mondai 1 Choose the correct reading."
    assert suggestions[0].answer == "1 first"
    chat_request = provider.requests[-1]
    assert chat_request["path"] == "/chat/completions"
    assert chat_request["body"]["model"] == "qwen3.5:4b"
    assert chat_request["body"]["response_format"] == {"type": "json_object"}


def test_fastflowlm_json_mode_retries_without_response_format() -> None:
    provider = RecordingFastFlowLMProvider(
        models=["qwen3.5:4b"],
        chat_content='{"answer":"2","rationale":"Choice 2 fits.","confidence":0.7}',
        fail_response_format=True,
    )
    chunk = SourceChunk(
        id="chunk-1",
        page_number=1,
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
        citation_page=1,
        source_excerpt="Question text.",
    )

    suggestion = provider.generate_fast_first_draft(chunk, candidate)

    assert suggestion is not None
    assert suggestion.answer == "2 second"
    chat_requests = [
        request for request in provider.requests if request["path"] == "/chat/completions"
    ]
    assert "response_format" in chat_requests[0]["body"]
    assert "response_format" not in chat_requests[1]["body"]


def test_fastflowlm_timeout_does_not_switch_to_fallback_model() -> None:
    provider = RecordingFastFlowLMProvider(
        models=["qwen3.5:4b", "qwen3.5:2b"],
        chat_content='{"answer":"2","rationale":"Choice 2 fits.","confidence":0.7}',
        fail_models={"qwen3.5:4b": ProviderUnavailableError("timed out")},
    )
    chunk = SourceChunk(
        id="chunk-1",
        page_number=1,
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
        citation_page=1,
        source_excerpt="Question text.",
    )

    suggestion = provider.generate_fast_first_draft(chunk, candidate)

    assert suggestion is None
    chat_requests = [
        request for request in provider.requests if request["path"] == "/chat/completions"
    ]
    assert [request["body"]["model"] for request in chat_requests] == ["qwen3.5:4b"]
    health = provider.health()
    assert health.available is True
    assert health.effective_model == "qwen3.5:4b"
    assert health.fallback_reason is None


def test_fastflowlm_health_falls_back_to_2b_when_available_ram_is_low(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        fastflowlm_transport,
        "available_system_ram_bytes",
        lambda: 3 * GIB,
    )
    provider = RecordingFastFlowLMProvider(
        models=["qwen3.5:4b", "qwen3.5:2b"],
        primary_min_available_ram_bytes=6 * GIB,
    )

    health = provider.health()

    assert health.available is True
    assert health.configured_model == "qwen3.5:4b"
    assert health.effective_model == "qwen3.5:2b"
    assert health.fallback_reason is not None
    assert "Available system RAM 3.0 GiB" in health.fallback_reason
    assert "using fallback qwen3.5:2b" in health.fallback_reason


def test_fastflowlm_generation_skips_4b_when_available_ram_is_low(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        fastflowlm_transport,
        "available_system_ram_bytes",
        lambda: 3 * GIB,
    )
    provider = RecordingFastFlowLMProvider(
        models=["qwen3.5:4b", "qwen3.5:2b"],
        chat_content='{"answer":"2","rationale":"Fallback fits.","confidence":0.7}',
        primary_min_available_ram_bytes=6 * GIB,
    )
    chunk = SourceChunk(
        id="chunk-1",
        page_number=1,
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
        citation_page=1,
        source_excerpt="Question text.",
    )

    suggestion = provider.generate_fast_first_draft(chunk, candidate)

    assert suggestion is not None
    assert suggestion.answer == "2 second"
    chat_requests = [
        request for request in provider.requests if request["path"] == "/chat/completions"
    ]
    assert [request["body"]["model"] for request in chat_requests] == ["qwen3.5:2b"]
    health = provider.health()
    assert health.effective_model == "qwen3.5:2b"


def test_ollama_health_uses_installed_fallback_without_pull(monkeypatch) -> None:
    fake_client = RecordingOllamaClient(models=["qwen3.5:2b"])
    monkeypatch.setattr(
        ollama_transport, "resolve_ollama_executable", lambda: Path("ollama")
    )
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3.5:4b",
        timeout_seconds=1,
        fallback_models=["qwen3.5:2b"],
    )
    provider._client = fake_client

    health = provider.health()

    assert health.available is True
    assert health.model == "qwen3.5:4b"
    assert health.configured_model == "qwen3.5:4b"
    assert health.effective_model == "qwen3.5:2b"
    assert health.fallback_models == ("qwen3.5:2b",)
    assert (
        health.fallback_reason
        == "Configured model qwen3.5:4b is missing; using fallback qwen3.5:2b."
    )
    assert health.unavailable_reason is None
    assert fake_client.chat_calls == []
    assert fake_client.pull_calls == 0


def test_ollama_health_uses_http_api_when_cli_is_not_on_path(monkeypatch) -> None:
    fake_client = RecordingOllamaClient(models=["qwen3.5:2b"])
    monkeypatch.setattr(ollama_transport, "resolve_ollama_executable", lambda: None)
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3.5:4b",
        timeout_seconds=1,
        fallback_models=["qwen3.5:2b"],
    )
    provider._client = fake_client

    health = provider.health()

    assert health.available is True
    assert health.effective_model == "qwen3.5:2b"
    assert health.fallback_reason is not None
    assert "using fallback qwen3.5:2b" in health.fallback_reason
    assert fake_client.pull_calls == 0


def test_ollama_health_starts_installed_idle_server(monkeypatch) -> None:
    fake_client = FlakyListOllamaClient(models=["qwen3.5:2b"])
    start_calls: list[tuple[str, Path | None]] = []
    monkeypatch.setattr(ollama_transport, "resolve_ollama_executable", lambda: Path("ollama"))
    monkeypatch.setattr(
        ollama_transport,
        "ensure_ollama_server_running",
        lambda host, *, executable=None: start_calls.append((host, executable)) or True,
    )
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3.5:4b",
        timeout_seconds=1,
        fallback_models=["qwen3.5:2b"],
    )
    provider._client = fake_client

    health = provider.health()

    assert health.available is True
    assert health.effective_model == "qwen3.5:2b"
    assert start_calls == [("http://127.0.0.1:11434", Path("ollama"))]
    assert fake_client.list_calls == 2
    assert fake_client.pull_calls == 0


def test_ollama_health_reports_not_running_when_idle_server_start_fails(
    monkeypatch,
) -> None:
    fake_client = FailingListOllamaClient()
    monkeypatch.setattr(ollama_transport, "resolve_ollama_executable", lambda: Path("ollama"))
    monkeypatch.setattr(
        ollama_transport,
        "ensure_ollama_server_running",
        lambda _host, *, executable=None: False,
    )
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3.5:4b",
        timeout_seconds=1,
        fallback_models=["qwen3.5:2b"],
    )
    provider._client = fake_client

    health = provider.health()

    assert health.available is False
    assert health.unavailable_reason == "ollama_not_running"
    assert "Ollama unavailable" in health.detail
    assert fake_client.pull_calls == 0


def test_ollama_prewarm_only_chats_when_configured_model_exists(monkeypatch) -> None:
    fake_client = RecordingOllamaClient(models=["qwen3.5:4b"])
    monkeypatch.setattr(ollama_transport, "resolve_ollama_executable", lambda: Path("ollama"))
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3.5:4b",
        timeout_seconds=1,
    )
    provider._client = fake_client

    provider.prewarm()

    assert fake_client.chat_calls == [
        {
            "model": "qwen3.5:4b",
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
        model="qwen3.5:4b",
        timeout_seconds=1,
    )
    provider._client = fake_client

    provider.prewarm()

    assert fake_client.chat_calls == []
    assert fake_client.pull_calls == 0


def test_ollama_prewarm_uses_available_fallback_model(monkeypatch) -> None:
    fake_client = RecordingOllamaClient(models=["qwen3.5:2b"])
    monkeypatch.setattr(
        ollama_transport, "resolve_ollama_executable", lambda: Path("ollama")
    )
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3.5:4b",
        timeout_seconds=1,
        fallback_models=["qwen3.5:2b"],
    )
    provider._client = fake_client

    provider.prewarm()

    assert fake_client.chat_calls[0]["model"] == "qwen3.5:2b"
    assert fake_client.pull_calls == 0


def test_ollama_prewarm_falls_back_when_primary_runtime_fails(monkeypatch) -> None:
    fake_client = RecordingOllamaClient(
        models=["qwen3.5:4b", "qwen3.5:2b"],
        fail_models={"qwen3.5:4b": RuntimeError("model requires more memory")},
    )
    monkeypatch.setattr(
        ollama_transport, "resolve_ollama_executable", lambda: Path("ollama")
    )
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3.5:4b",
        timeout_seconds=1,
        fallback_models=["qwen3.5:2b"],
    )
    provider._client = fake_client

    provider.prewarm()

    assert [call["model"] for call in fake_client.chat_calls] == [
        "qwen3.5:4b",
        "qwen3.5:2b",
    ]
    health = provider.health()
    assert health.effective_model == "qwen3.5:2b"
    assert health.fallback_reason is not None
    assert "unavailable during generation" in health.fallback_reason
    assert fake_client.pull_calls == 0


def test_ollama_fast_first_draft_maps_compact_json_to_candidate_choice(
    monkeypatch,
) -> None:
    fake_client = RecordingOllamaClient(
        models=["qwen3.5:4b"],
        chat_content='{"answer":"2","rationale":"Qwen picked the closest reading.","confidence":"high"}',
    )
    monkeypatch.setattr(ollama_transport, "resolve_ollama_executable", lambda: Path("ollama"))
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3.5:4b",
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
        models=["qwen3.5:4b", "qwen3.5:2b"],
        chat_content='{"answer":"2","rationale":"Fallback picked the answer.","confidence":0.72}',
        fail_models={"qwen3.5:4b": RuntimeError("model requires more memory")},
    )
    monkeypatch.setattr(
        ollama_transport, "resolve_ollama_executable", lambda: Path("ollama")
    )
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3.5:4b",
        timeout_seconds=1,
        fallback_models=["qwen3.5:2b"],
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
        "qwen3.5:4b",
        "qwen3.5:2b",
    ]
    health = provider.health()
    assert health.effective_model == "qwen3.5:2b"
    assert health.fallback_reason is not None
    assert "model requires more memory" in health.fallback_reason
    assert fake_client.pull_calls == 0


def test_ollama_fast_first_invalid_json_does_not_mark_model_unusable(
    monkeypatch,
) -> None:
    fake_client = RecordingOllamaClient(models=["qwen3.5:4b"], chat_content="not-json")
    monkeypatch.setattr(
        ollama_transport, "resolve_ollama_executable", lambda: Path("ollama")
    )
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3.5:4b",
        timeout_seconds=1,
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

    assert suggestion is None
    health = provider.health()
    assert health.available is True
    assert health.effective_model == "qwen3.5:4b"
    assert health.fallback_reason is None
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


class RecordingFastFlowLMProvider(FastFlowLMProvider):
    def __init__(
        self,
        *,
        models: list[str],
        chat_content: str = '{"items":[]}',
        fail_response_format: bool = False,
        fail_models: dict[str, Exception] | None = None,
        primary_min_available_ram_bytes: int = 0,
    ) -> None:
        super().__init__(
            base_url="http://127.0.0.1:52625/v1",
            model="qwen3.5:4b",
            timeout_seconds=1,
            fallback_models=["qwen3.5:2b"],
            primary_min_available_ram_bytes=primary_min_available_ram_bytes,
        )
        self.models = models
        self.chat_content = chat_content
        self.fail_response_format = fail_response_format
        self.fail_models = fail_models or {}
        self.requests: list[dict] = []

    def _request_json(
        self,
        method: str,
        path: str,
        *,
        body: dict | None = None,
        timeout_seconds: float | None = None,
    ) -> dict:
        self.requests.append(
            {
                "method": method,
                "path": path,
                "body": copy.deepcopy(body),
                "timeout_seconds": timeout_seconds,
            }
        )
        if path == "/models":
            return {"data": [{"id": model} for model in self.models]}
        if (
            path == "/chat/completions"
            and self.fail_response_format
            and isinstance(body, dict)
            and "response_format" in body
        ):
            raise ProviderUnavailableError("response_format is not supported")
        if path == "/chat/completions":
            model = body.get("model") if isinstance(body, dict) else None
            if isinstance(model, str) and model in self.fail_models:
                raise self.fail_models[model]
            return {"choices": [{"message": {"content": self.chat_content}}]}
        raise AssertionError(f"Unexpected request: {method} {path}")


class FlakyListOllamaClient(RecordingOllamaClient):
    def __init__(self, *, models: list[str]) -> None:
        super().__init__(models=models)
        self.list_calls = 0

    def list(self) -> dict:
        self.list_calls += 1
        if self.list_calls == 1:
            raise RuntimeError("connection refused")
        return super().list()


class FailingListOllamaClient(RecordingOllamaClient):
    def __init__(self) -> None:
        super().__init__(models=[])
        self.list_calls = 0

    def list(self) -> dict:
        self.list_calls += 1
        raise RuntimeError("connection refused")


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
