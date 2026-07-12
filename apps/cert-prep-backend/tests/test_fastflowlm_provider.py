from pathlib import Path
from types import SimpleNamespace

from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.core.config import DEFAULT_FASTFLOWLM_MODEL
from cert_prep_backend.domains.mock_exams import fastflowlm_resolver, fastflowlm_transport
from cert_prep_backend.domains.mock_exams.fastflowlm_transport import FastFlowLMProvider
from cert_prep_backend.domains.mock_exams.models import DraftSuggestion, SourceChunk
from llm_test_fakes import AutoStartFastFlowLMProvider, GIB, RecordingFastFlowLMProvider


def test_fastflowlm_health_reports_missing_runtime_without_model_download(monkeypatch) -> None:
    monkeypatch.setattr(
        fastflowlm_transport,
        "resolve_fastflowlm_executable",
        lambda *_args: None,
    )
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
    program_files = tmp_path / "Program Files"
    install_dir = program_files / "flm"
    install_dir.mkdir(parents=True)
    executable = install_dir / "flm.exe"
    executable.write_text("", encoding="utf-8")
    monkeypatch.setattr(fastflowlm_resolver.os, "name", "nt")
    monkeypatch.setattr(
        fastflowlm_resolver,
        "_known_folder_path",
        lambda folder_id: (
            program_files
            if folder_id == fastflowlm_resolver._FOLDER_ID_PROGRAM_FILES
            else tmp_path / "unused"
        ),
    )
    monkeypatch.setattr(
        fastflowlm_resolver,
        "is_allowlisted_fastflowlm_executable",
        lambda path: path == executable.resolve(),
    )

    assert fastflowlm_transport.resolve_fastflowlm_executable() == executable.resolve()

def test_fastflowlm_pull_uses_runtime_install_timeout(monkeypatch, tmp_path) -> None:
    executable = tmp_path / "flm.exe"
    executable.write_text("", encoding="utf-8")
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        fastflowlm_transport,
        "resolve_fastflowlm_executable",
        lambda *_args: executable,
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

def test_fastflowlm_generation_retries_4b_after_ram_recovers(monkeypatch) -> None:
    available_ram_bytes = {"value": 3 * GIB}
    monkeypatch.setattr(
        fastflowlm_transport,
        "available_system_ram_bytes",
        lambda: available_ram_bytes["value"],
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

    first_suggestion = provider.generate_fast_first_draft(chunk, candidate)

    assert first_suggestion is not None
    assert first_suggestion.answer == "2 second"
    chat_requests = [
        request for request in provider.requests if request["path"] == "/chat/completions"
    ]
    assert [request["body"]["model"] for request in chat_requests] == ["qwen3.5:2b"]
    low_ram_health = provider.health()
    assert low_ram_health.effective_model == "qwen3.5:2b"
    assert low_ram_health.fallback_reason is not None

    available_ram_bytes["value"] = 8 * GIB

    second_suggestion = provider.generate_fast_first_draft(chunk, candidate)

    assert second_suggestion is not None
    assert second_suggestion.answer == "2 second"
    chat_requests = [
        request for request in provider.requests if request["path"] == "/chat/completions"
    ]
    assert [request["body"]["model"] for request in chat_requests] == [
        "qwen3.5:2b",
        "qwen3.5:4b",
    ]
    recovered_health = provider.health()
    assert recovered_health.effective_model == "qwen3.5:4b"
    assert recovered_health.fallback_reason is None

def test_fastflowlm_generation_autostarts_and_releases_owned_server(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        fastflowlm_transport,
        "resolve_fastflowlm_executable",
        lambda *_args: Path("flm"),
    )
    provider = AutoStartFastFlowLMProvider(
        models=["qwen3.5:4b"],
        chat_content='{"answer":"2","rationale":"Owned server fits.","confidence":0.7}',
        owned_server_idle_timeout_seconds=0,
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
    assert provider.started_servers == [{"model": "qwen3.5:4b", "host": "127.0.0.1", "port": 52625}]
    assert provider.processes[0].terminate_calls == 0

    provider.release_resources()

    assert provider.processes[0].terminate_calls == 1
    assert provider.processes[0].kill_calls == 0

def test_fastflowlm_autostarts_fallback_server_when_primary_ram_is_low(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        fastflowlm_transport,
        "resolve_fastflowlm_executable",
        lambda *_args: Path("flm"),
    )
    monkeypatch.setattr(
        fastflowlm_transport,
        "available_system_ram_bytes",
        lambda: 3 * GIB,
    )
    provider = AutoStartFastFlowLMProvider(
        models=["qwen3.5:4b", "qwen3.5:2b"],
        chat_content='{"answer":"2","rationale":"Fallback fits.","confidence":0.7}',
        primary_min_available_ram_bytes=6 * GIB,
        owned_server_idle_timeout_seconds=0,
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
    assert provider.started_servers == [{"model": "qwen3.5:2b", "host": "127.0.0.1", "port": 52625}]
    chat_requests = [
        request for request in provider.requests if request["path"] == "/chat/completions"
    ]
    assert [request["body"]["model"] for request in chat_requests] == ["qwen3.5:2b"]
    provider.release_resources()
    assert provider.processes[0].terminate_calls == 1
