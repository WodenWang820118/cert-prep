import json
from pathlib import Path

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.mock_exams import ollama_profiles as ollama_profile_module
from cert_prep_backend.domains.mock_exams import ollama_transport
from cert_prep_backend.domains.mock_exams.models import DraftSuggestion, SourceChunk
from cert_prep_backend.domains.mock_exams.ollama_transport import OllamaProvider
from cert_prep_ollama.profiles import DEFAULT_PROFILE_ID, select_ollama_profile
from fastapi.testclient import TestClient
from llm_test_fakes import (
    FailingListOllamaClient,
    FlakyListOllamaClient,
    GIB,
    RecordingOllamaClient,
    _profile_inventory,
)


AUTH_HEADERS = {"Authorization": "Bearer test-token"}


class SequencedOllamaClient(RecordingOllamaClient):
    def __init__(self, *, models: list[str], chat_contents: list[str | Exception]) -> None:
        super().__init__(models=models)
        self._chat_contents = list(chat_contents)

    def chat(self, **kwargs) -> dict:
        if not self._chat_contents:
            raise AssertionError("unexpected additional Ollama chat call")
        next_content = self._chat_contents.pop(0)
        if isinstance(next_content, Exception):
            self.chat_calls.append(kwargs)
            raise next_content
        self.chat_content = next_content
        return super().chat(**kwargs)


def _reasoning_chunks() -> list[SourceChunk]:
    return [
        SourceChunk(
            id="chunk-1",
            page_number=2,
            text="Question 1 Choose the correct word. A alpha B beta.",
            source_excerpt="Question 1 Choose the correct word.",
        ),
        SourceChunk(
            id="chunk-2",
            page_number=3,
            text="Question 2 Choose the correct word. A gamma B delta.",
            source_excerpt="Question 2 Choose the correct word.",
        ),
    ]


def _reasoning_item(chunk: SourceChunk, number: int) -> dict:
    first, second = (("alpha", "beta") if number == 1 else ("gamma", "delta"))
    question = f"Question {number} Choose the correct word."
    return {
        "chunk_id": chunk.id,
        "citation_page": chunk.page_number,
        "question": question,
        "choices": [f"A {first}", f"B {second}"],
        "answer": "A",
        "answer_key_source": "ai_inferred",
        "rationale": f"The visible source supports {first}.",
        "source_excerpt": question,
        "confidence": 0.9,
        "source_question_number": str(number),
    }


def test_ollama_health_uses_installed_fallback_without_pull(monkeypatch) -> None:
    fake_client = RecordingOllamaClient(models=["qwen3.5:2b"])
    monkeypatch.setattr(ollama_transport, "resolve_ollama_executable", lambda: Path("ollama"))
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

def test_ollama_health_includes_profile_selection_fields(monkeypatch) -> None:
    selection = select_ollama_profile(
        _profile_inventory(total_ram=16 * GIB, free_disk=64 * GIB),
        profile_id=DEFAULT_PROFILE_ID,
    )
    fake_client = RecordingOllamaClient(models=[selection.selected_profile.local_model])
    monkeypatch.setattr(ollama_transport, "resolve_ollama_executable", lambda: Path("ollama"))
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model=selection.selected_profile.local_model,
        timeout_seconds=1,
        fallback_models=[profile.local_model for profile in selection.fallback_profiles],
        profile_selection=selection,
    )
    provider._client = fake_client

    health = provider.health()

    assert health.available is True
    assert health.profile_id == DEFAULT_PROFILE_ID
    assert health.base_model == "qwen3.5:4b"
    assert health.modelfile_sha256 == selection.modelfile_sha256
    assert health.profile_reason == selection.reason
    assert health.profile_warnings == selection.warnings
    assert health.effective_model == selection.selected_profile.local_model
    assert fake_client.pull_calls == 0


def test_ollama_health_accepts_implicit_latest_profile_alias(monkeypatch) -> None:
    model = "cert-prep-qwen3.5-4b-study-8k"
    fake_client = RecordingOllamaClient(models=[f"{model}:latest"])
    monkeypatch.setattr(ollama_transport, "resolve_ollama_executable", lambda: Path("ollama"))
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model=model,
        timeout_seconds=1,
    )
    provider._client = fake_client

    health = provider.health()

    assert health.available is True
    assert health.configured_model == model
    assert health.effective_model == model
    assert health.unavailable_reason is None
    assert fake_client.pull_calls == 0


def test_ollama_runtime_unusable_models_can_recover() -> None:
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3.5:4b",
        timeout_seconds=1,
        fallback_models=["qwen3.5:2b"],
    )

    provider._mark_model_unusable("qwen3.5:4b", RuntimeError("transient OOM"))
    assert "qwen3.5:4b" in provider._runtime_unusable_models()

    provider._record_model_success("qwen3.5:4b")

    assert "qwen3.5:4b" not in provider._runtime_unusable_models()


def test_ollama_reasoning_requests_exact_distinct_count_when_source_supports_it() -> None:
    chunks = _reasoning_chunks()
    fake_client = RecordingOllamaClient(
        models=["qwen3.5:4b"],
        chat_content=json.dumps(
            {"items": [_reasoning_item(chunks[0], 1), _reasoning_item(chunks[1], 2)]}
        ),
    )
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3.5:4b",
        timeout_seconds=1,
        client=fake_client,
    )

    suggestions = provider.generate_reasoning_drafts(chunks, limit=2)

    assert [suggestion.source_question_number for suggestion in suggestions] == ["1", "2"]
    assert len(fake_client.chat_calls) == 1
    prompt = fake_client.chat_calls[0]["messages"][1]["content"]
    assert "If at least 2 valid items are present, return exactly 2" in prompt
    assert "If fewer valid items are present, return only those items" in prompt
    assert "Never invent, duplicate, or split an item" in prompt


def test_ollama_reasoning_uses_one_supplemental_pass_for_a_short_grounded_result() -> None:
    chunks = _reasoning_chunks()
    fake_client = SequencedOllamaClient(
        models=["qwen3.5:4b"],
        chat_contents=[
            json.dumps({"items": [_reasoning_item(chunks[0], 1)]}),
            json.dumps({"items": [_reasoning_item(chunks[1], 2)]}),
        ],
    )
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3.5:4b",
        timeout_seconds=1,
        client=fake_client,
    )

    suggestions = provider.generate_reasoning_drafts(chunks, limit=2)

    assert [suggestion.source_question_number for suggestion in suggestions] == ["1", "2"]
    assert len(fake_client.chat_calls) == 2
    assert fake_client.chat_calls[0]["model"] == fake_client.chat_calls[1]["model"]
    assert fake_client.chat_calls[0]["options"] == fake_client.chat_calls[1]["options"]
    assert fake_client.chat_calls[0]["keep_alive"] == fake_client.chat_calls[1]["keep_alive"]
    supplemental_prompt = fake_client.chat_calls[1]["messages"][1]["content"]
    assert "single supplemental pass" in supplemental_prompt
    assert "chunk_id=chunk-1" in supplemental_prompt
    assert "[[chunk_id:chunk-2 page:3]]" in supplemental_prompt


def test_ollama_reasoning_supplements_a_malformed_initial_item_once() -> None:
    chunks = [
        *_reasoning_chunks(),
        SourceChunk(
            id="chunk-3",
            page_number=4,
            text="Question 3 Choose the correct word. A gamma B delta.",
            source_excerpt="Question 3 Choose the correct word.",
        ),
    ]
    malformed = {
        **_reasoning_item(chunks[0], 1),
        "choices": ["alpha"],
        "answer": "alpha",
    }
    fake_client = SequencedOllamaClient(
        models=["qwen3.5:4b"],
        chat_contents=[
            json.dumps({"items": [malformed]}),
            json.dumps(
                {"items": [_reasoning_item(chunks[2], 3), _reasoning_item(chunks[0], 1)]}
            ),
        ],
    )
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3.5:4b",
        timeout_seconds=1,
        client=fake_client,
    )

    suggestions = provider.generate_reasoning_drafts(chunks, limit=2)

    assert [suggestion.source_question_number for suggestion in suggestions] == ["3", "1"]
    assert len(fake_client.chat_calls) == 2
    supplemental_prompt = fake_client.chat_calls[1]["messages"][1]["content"]
    assert "No item from the prior response passed strict validation" in supplemental_prompt
    assert supplemental_prompt.index("[[chunk_id:chunk-3") < supplemental_prompt.index(
        "[[chunk_id:chunk-1"
    )


def test_ollama_reasoning_stops_after_one_empty_supplemental_pass() -> None:
    chunks = _reasoning_chunks()
    fake_client = SequencedOllamaClient(
        models=["qwen3.5:4b"],
        chat_contents=[
            json.dumps({"items": [_reasoning_item(chunks[0], 1)]}),
            json.dumps({"items": []}),
        ],
    )
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3.5:4b",
        timeout_seconds=1,
        client=fake_client,
    )

    suggestions = provider.generate_reasoning_drafts(chunks, limit=2)

    assert [suggestion.source_question_number for suggestion in suggestions] == ["1"]
    assert len(fake_client.chat_calls) == 2


def test_ollama_reasoning_discards_a_supplemental_duplicate_before_filling() -> None:
    chunks = _reasoning_chunks()
    fake_client = SequencedOllamaClient(
        models=["qwen3.5:4b"],
        chat_contents=[
            json.dumps({"items": [_reasoning_item(chunks[0], 1)]}),
            json.dumps(
                {"items": [_reasoning_item(chunks[0], 1), _reasoning_item(chunks[1], 2)]}
            ),
        ],
    )
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3.5:4b",
        timeout_seconds=1,
        client=fake_client,
    )

    suggestions = provider.generate_reasoning_drafts(chunks, limit=2)

    assert [suggestion.source_question_number for suggestion in suggestions] == ["1", "2"]
    assert len(fake_client.chat_calls) == 2


def test_ollama_reasoning_does_not_supplement_a_single_item_streaming_request() -> None:
    chunks = _reasoning_chunks()
    malformed = {
        **_reasoning_item(chunks[0], 1),
        "choices": ["alpha"],
        "answer": "alpha",
    }
    fake_client = SequencedOllamaClient(
        models=["qwen3.5:4b"],
        chat_contents=[json.dumps({"items": [malformed]})],
    )
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3.5:4b",
        timeout_seconds=1,
        client=fake_client,
    )

    assert provider.generate_reasoning_drafts(chunks, limit=1) == []
    assert len(fake_client.chat_calls) == 1


def test_ollama_reasoning_does_not_supplement_notice_only_source() -> None:
    notice = SourceChunk(
        id="notice",
        page_number=1,
        text="JLPT N1 test booklet title and version notice.",
        source_excerpt="JLPT N1 test booklet title and version notice.",
    )
    fake_client = SequencedOllamaClient(
        models=["qwen3.5:4b"],
        chat_contents=[json.dumps({"items": []})],
    )
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3.5:4b",
        timeout_seconds=1,
        client=fake_client,
    )

    assert provider.generate_reasoning_drafts([notice], limit=2) == []
    assert len(fake_client.chat_calls) == 1


def test_ollama_reasoning_supplements_a_valid_source_classifier_false_negative() -> None:
    chunks = [
        SourceChunk(
            id="chunk-1",
            page_number=2,
            text="Question 1. 1 foo 2 bar",
            source_excerpt="Question 1.",
        ),
        SourceChunk(
            id="chunk-2",
            page_number=3,
            text="Question 2. 1 baz 2 qux",
            source_excerpt="Question 2.",
        ),
    ]
    first = {
        "chunk_id": "chunk-1",
        "citation_page": 2,
        "question": "Question 1.",
        "choices": ["1 foo", "2 bar"],
        "answer": "1",
        "answer_key_source": "ai_inferred",
        "rationale": "The visible source supports foo.",
        "source_excerpt": "Question 1.",
        "confidence": 0.9,
        "source_question_number": "1",
    }
    second = {
        "chunk_id": "chunk-2",
        "citation_page": 3,
        "question": "Question 2.",
        "choices": ["1 baz", "2 qux"],
        "answer": "2",
        "answer_key_source": "ai_inferred",
        "rationale": "The visible source supports qux.",
        "source_excerpt": "Question 2.",
        "confidence": 0.9,
        "source_question_number": "2",
    }
    fake_client = SequencedOllamaClient(
        models=["qwen3.5:4b"],
        chat_contents=[
            json.dumps({"items": [first]}),
            json.dumps({"items": [second]}),
        ],
    )
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3.5:4b",
        timeout_seconds=1,
        client=fake_client,
    )

    suggestions = provider.generate_reasoning_drafts(chunks, limit=2)

    assert [suggestion.source_question_number for suggestion in suggestions] == ["1", "2"]
    assert len(fake_client.chat_calls) == 2


def test_ollama_reasoning_restarts_both_passes_atomically_on_model_fallback() -> None:
    chunks = _reasoning_chunks()
    primary_item = {**_reasoning_item(chunks[0], 1), "rationale": "primary partial"}
    fallback_items = [
        {**_reasoning_item(chunks[0], 1), "rationale": "fallback first"},
        {**_reasoning_item(chunks[1], 2), "rationale": "fallback second"},
    ]
    fake_client = SequencedOllamaClient(
        models=["qwen3.5:4b", "qwen3.5:2b"],
        chat_contents=[
            json.dumps({"items": [primary_item]}),
            RuntimeError("primary model runner crashed"),
            json.dumps({"items": fallback_items}),
        ],
    )
    provider = OllamaProvider(
        host="http://127.0.0.1:11434",
        model="qwen3.5:4b",
        fallback_models=["qwen3.5:2b"],
        timeout_seconds=1,
        client=fake_client,
    )

    suggestions = provider.generate_reasoning_drafts(chunks, limit=2)

    assert [call["model"] for call in fake_client.chat_calls] == [
        "qwen3.5:4b",
        "qwen3.5:4b",
        "qwen3.5:2b",
    ]
    assert [suggestion.rationale for suggestion in suggestions] == [
        "fallback first",
        "fallback second",
    ]
    attribution = provider.generation_attribution()
    assert attribution.effective_model == "qwen3.5:2b"
    assert attribution.fallback_reason is not None

def test_ollama_profile_apis_return_200(monkeypatch, tmp_path) -> None:
    inventory = _profile_inventory(total_ram=16 * GIB, free_disk=64 * GIB)
    monkeypatch.setattr(
        ollama_profile_module,
        "collect_machine_inventory",
        lambda **_kwargs: inventory,
    )
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                llm_provider="ollama",
            ),
            runtime_installation_async_jobs=False,
        )
    )

    profiles_response = client.get("/llm/profiles", headers=AUTH_HEADERS)
    selection_response = client.get("/llm/profile-selection", headers=AUTH_HEADERS)
    inventory_response = client.get("/runtime/machine-inventory", headers=AUTH_HEADERS)

    assert profiles_response.status_code == 200
    assert any(
        item["profile_id"] == DEFAULT_PROFILE_ID for item in profiles_response.json()["items"]
    )
    assert selection_response.status_code == 200
    assert selection_response.json()["profile_id"] == DEFAULT_PROFILE_ID
    assert selection_response.json()["effective_model"] == "cert-prep-qwen3.5-4b-study-8k"
    assert inventory_response.status_code == 200
    assert inventory_response.json()["ram"]["total_bytes"] == 16 * GIB

def test_ollama_profile_selection_api_reports_disabled_raw_model(tmp_path) -> None:
    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                llm_provider="ollama",
                ollama_profile_enabled=False,
                ollama_model="raw-local:latest",
                ollama_fallback_models=["raw-fallback:latest"],
            ),
            runtime_installation_async_jobs=False,
        )
    )

    response = client.get("/llm/profile-selection", headers=AUTH_HEADERS)

    assert response.status_code == 200
    assert response.json()["profile_enabled"] is False
    assert response.json()["effective_model"] == "raw-local:latest"
    assert response.json()["fallback_models"] == ["raw-fallback:latest"]

def test_ollama_machine_inventory_is_cached_and_refreshable(monkeypatch, tmp_path) -> None:
    inventories = [
        _profile_inventory(total_ram=16 * GIB, free_disk=64 * GIB),
        _profile_inventory(total_ram=12 * GIB, free_disk=32 * GIB),
    ]
    calls: list[object] = []

    def fake_collect_machine_inventory(**_kwargs):
        calls.append(object())
        return inventories[min(len(calls) - 1, len(inventories) - 1)]

    monkeypatch.setattr(
        ollama_profile_module,
        "collect_machine_inventory",
        fake_collect_machine_inventory,
    )
    settings = Settings(data_dir=tmp_path, llm_provider="ollama")

    first = ollama_profile_module.collect_ollama_machine_inventory(settings)
    second = ollama_profile_module.collect_ollama_machine_inventory(settings)
    refreshed = ollama_profile_module.collect_ollama_machine_inventory(
        settings,
        refresh=True,
    )

    assert first is second
    assert refreshed is inventories[1]
    assert len(calls) == 2

def test_ollama_profile_inventory_is_deferred_until_used(monkeypatch, tmp_path) -> None:
    calls: list[object] = []
    inventory = _profile_inventory(total_ram=16 * GIB, free_disk=64 * GIB)

    def fake_collect_machine_inventory(**_kwargs):
        calls.append(object())
        return inventory

    monkeypatch.setattr(
        ollama_profile_module,
        "collect_machine_inventory",
        fake_collect_machine_inventory,
    )

    client = TestClient(
        create_app(
            settings=Settings(
                data_dir=tmp_path,
                api_token="test-token",
                llm_provider="ollama",
            ),
            runtime_installation_async_jobs=False,
        )
    )

    assert calls == []
    assert client.get("/health").status_code == 200
    assert calls == []

    response = client.get("/llm/profile-selection", headers=AUTH_HEADERS)

    assert response.status_code == 200
    assert response.json()["profile_id"] == DEFAULT_PROFILE_ID
    assert len(calls) == 1

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

def test_ollama_fast_first_draft_forwards_keep_alive_override(
    monkeypatch,
) -> None:
    fake_client = RecordingOllamaClient(
        models=["qwen3.5:4b"],
        chat_content='{"answer":"2","rationale":"Qwen picked the answer.","confidence":0.7}',
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

    suggestion = provider.generate_fast_first_draft(
        chunk,
        candidate,
        keep_alive=ollama_transport.STREAMING_RELEASE_KEEP_ALIVE,
    )

    assert suggestion is not None
    assert suggestion.answer == "2 second"
    assert fake_client.chat_calls[0]["keep_alive"] == 0
    assert fake_client.pull_calls == 0

def test_ollama_fast_first_draft_falls_back_when_primary_runtime_fails(
    monkeypatch,
) -> None:
    fake_client = RecordingOllamaClient(
        models=["qwen3.5:4b", "qwen3.5:2b"],
        chat_content='{"answer":"2","rationale":"Fallback picked the answer.","confidence":0.72}',
        fail_models={"qwen3.5:4b": RuntimeError("model requires more memory")},
    )
    monkeypatch.setattr(ollama_transport, "resolve_ollama_executable", lambda: Path("ollama"))
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
