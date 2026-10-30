from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from conftest import AUTH_TOKEN, TestCaptureRuntimeClient, minimal_pdf
from llm_test_fakes import RecordingOllamaClient
from cert_prep_backend.api.app import create_app
from cert_prep_backend.ai_providers.infrastructure.ollama_transport import OllamaProvider
from cert_prep_backend.authoring.domain.models import DraftGenerationStrategy, SourceChunk
from cert_prep_backend.authoring.infrastructure import repository as drafts_repository
from cert_prep_backend.authoring.infrastructure.streaming import _generation_attribution
from cert_prep_backend.authoring.infrastructure.sudachi_reading_lexicon import SudachiReadingLexicon
from cert_prep_backend.platform.config import Settings


READING_INSTRUCTION = "問題1 漢字の読み方を四つの候補から選びなさい。"
OTHER_INSTRUCTION = "問題2 内容に合う答えを四つの候補から選びなさい。"
READING_ITEM = "1 絶叫が会場に響いた。\n1 ぜっこう 2 ぜっきょう 3 せっきょう 4 ぜつきょう"
READING_TEXT = f"{READING_INSTRUCTION}\n{READING_ITEM}"
PARTICLE_TEXT = "1 校門を出て、駅（　）向かった。\n1 の 2 で 3 が 4 と"
BLANK_TEXT = "1 今日は雨なので、（　）を持って出かけます。\n1 あめ 2 かさ 3 くつ 4 かばん"
REVIEW_ITEMS = [
    "1 「雨」と逆の意味になる語はどれか。\n1 あめ 2 はれ 3 くもり 4 ゆき",
    "1 庭に一匹の猫が来た。\n1 いっぴき 2 いちひき 3 いっひき 4 いちびき",
    "1 切符は三百円だった。\n1 さんびゃく 2 さんひゃく 3 さんぴゃく 4 みひゃく",
]
HEADERS = {"Authorization": f"Bearer {AUTH_TOKEN}"}


@pytest.mark.parametrize("path", ["batch", "streaming", "manual"])
@pytest.mark.parametrize("enabled, text, calls", [
    (True, READING_TEXT, 0),
    (True, READING_ITEM, 1),
    (True, f"{OTHER_INSTRUCTION}\n{READING_ITEM}", 1),
    (True, PARTICLE_TEXT, 1),
    pytest.param(True, BLANK_TEXT, 1, id="blank-kana"),
    (True, f"{READING_INSTRUCTION}\n{PARTICLE_TEXT}", 1),
    (True, f"{READING_INSTRUCTION}\n{BLANK_TEXT}", 1),
    (False, READING_TEXT, 1),
    (False, PARTICLE_TEXT, 1),
    *[(enabled, f"{instruction}{item}", 1)
      for enabled in (True, False)
      for instruction in ("", f"{OTHER_INSTRUCTION}\n")
      for item in REVIEW_ITEMS],
    *[(enabled, f"{READING_INSTRUCTION}\n{item}", 1)
      for enabled in (True, False)
      for item in REVIEW_ITEMS[1:]],
])
def test_inference_paths_and_saved_attribution(tmp_path, path, enabled, text, calls) -> None:
    fake_client = RecordingOllamaClient(
        models=["qwen3.5:4b"],
        chat_content='{"answer":"2","rationale":"模型解說。","confidence":0.7}',
    )
    provider = OllamaProvider("http://127.0.0.1:11434", "qwen3.5:4b", 1, client=fake_client)
    settings = Settings(
        data_dir=tmp_path, api_token=AUTH_TOKEN, reading_solver_enabled=enabled,
    )
    with TestClient(create_app(
        settings=settings,
        llm_provider=provider,
        capture_runtime_client=TestCaptureRuntimeClient(),
        document_processing_async_jobs=False,
        streaming_draft_generation_async_jobs=False,
    )) as client:
        project_id = client.post("/projects", headers=HEADERS, json={"name": "讀音"}).json()["id"]
        document = client.post(
            f"/projects/{project_id}/documents", headers=HEADERS,
            files={"file": ("source.pdf", minimal_pdf("Reference page."), "application/pdf")},
        ).json()
        document_id = document["id"]
        chunk = client.get(
            f"/projects/{project_id}/documents/{document_id}/chunks", headers=HEADERS,
        ).json()["items"][0]
        database = client.app.state.database
        with database.connect() as connection:
            connection.execute(
                "UPDATE document_chunks SET text = ?, raw_text = ? WHERE id = ?",
                (text, text, chunk["id"]),
            )
        manager = client.app.state.streaming_draft_generation_manager
        if path == "batch":
            suggestions = client.app.state.draft_writing.suggestions(
                provider, [SourceChunk(id=chunk["id"], page_number=1, text=text)],
                1, DraftGenerationStrategy.HYBRID_REASONING,
            )
            attribution = _generation_attribution(
                provider, generated=bool(suggestions),
                dictionary_only=all(item.dictionary_generated for item in suggestions),
            )
            assert "dictionary_generated" not in suggestions[0].to_serialized()
            assert "section_instruction" not in suggestions[0].to_serialized()
        else:
            if path == "streaming":
                settings.streaming_draft_generation_on_upload = True
                jobs = manager.enqueue_document(database, project_id=project_id, document_id=document_id)
                assert len(jobs) == 1
                attribution = jobs[0]
            else:
                attribution = manager.start_manual_operation(
                    database, project_id=project_id, document_id=document_id, limit=1,
                    strategy=DraftGenerationStrategy.HYBRID_REASONING,
                )
            assert attribution.status == "succeeded", attribution
            suggestions = drafts_repository.list_drafts(database, project_id)
        assert len(suggestions) == 1
        suggestion = suggestions[0]
        assert suggestion.answer_key_source == "ai_inferred"
        if calls == 0:
            assert suggestion.answer == "2 ぜっきょう"
            assert suggestion.rationale == "「絶叫」的讀音是「ぜっきょう」，所以答案是 2。"
            if path == "batch":
                assert suggestion.confidence == 1.0
            assert attribution.effective_provider is None
            assert attribution.effective_model is None
            assert provider.generation_attribution().effective_model is None
        else:
            assert suggestion.rationale == "模型解說。"
            assert attribution.effective_provider == "ollama"
            assert attribution.effective_model == "qwen3.5:4b"
    assert len(fake_client.chat_calls) == calls
    assert fake_client.pull_calls == 0


def test_dictionary_failure_falls_back_to_model() -> None:
    from cert_prep_backend.authoring.infrastructure.draft_writing import generate_drafts_for_strategy

    fake_client = RecordingOllamaClient(
        models=["qwen3.5:4b"],
        chat_content='{"answer":"2","rationale":"模型解說。","confidence":0.7}',
    )
    provider = OllamaProvider("http://127.0.0.1:11434", "qwen3.5:4b", 1, client=fake_client)
    with patch("sudachipy.Dictionary", side_effect=OSError("dictionary missing")):
        suggestions = generate_drafts_for_strategy(
            provider, [SourceChunk(id="chunk", page_number=1, text=READING_TEXT)], 1,
            DraftGenerationStrategy.HYBRID_REASONING, reading_lexicon=SudachiReadingLexicon(),
        )
    assert suggestions[0].rationale == "模型解說。"
    assert len(fake_client.chat_calls) == 1


def test_default_enabled_and_environment_can_disable(monkeypatch) -> None:
    monkeypatch.delenv("CERT_PREP_READING_SOLVER_ENABLED", raising=False)
    assert Settings().reading_solver_enabled is True
    monkeypatch.setenv("CERT_PREP_READING_SOLVER_ENABLED", "false")
    assert Settings().reading_solver_enabled is False


@pytest.mark.parametrize("dictionary_first", [True, False])
def test_mixed_generation_keeps_actual_model_attribution(dictionary_first) -> None:
    from cert_prep_backend.authoring.infrastructure.draft_writing import generate_drafts_for_strategy

    fake_client = RecordingOllamaClient(
        models=["qwen3.5:4b"],
        chat_content='{"answer":"2","rationale":"模型解說。","confidence":0.7}',
    )
    provider = OllamaProvider("http://127.0.0.1:11434", "qwen3.5:4b", 1, client=fake_client)
    texts = [READING_TEXT, PARTICLE_TEXT] if dictionary_first else [PARTICLE_TEXT, READING_TEXT]
    suggestions = generate_drafts_for_strategy(
        provider, [SourceChunk(id=str(index), page_number=index + 1, text=text)
                   for index, text in enumerate(texts)],
        2, DraftGenerationStrategy.HYBRID_REASONING, reading_lexicon=SudachiReadingLexicon(),
    )
    assert len(suggestions) == 2
    assert sum(suggestion.dictionary_generated for suggestion in suggestions) == 1
    assert len(fake_client.chat_calls) == 1
    attribution = _generation_attribution(
        provider, generated=bool(suggestions),
        dictionary_only=all(suggestion.dictionary_generated for suggestion in suggestions),
    )
    assert attribution.effective_model == "qwen3.5:4b"
    # Even if a provider still has attribution from a prior model call, a
    # dictionary-only result cannot inherit that model.
    assert _generation_attribution(
        provider, generated=True, dictionary_only=True,
    ).effective_model is None
    assert _generation_attribution(provider, generated=False).effective_model == "qwen3.5:4b"
