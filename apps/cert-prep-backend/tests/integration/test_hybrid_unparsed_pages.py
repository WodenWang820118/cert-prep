import json

import pytest
from fastapi.testclient import TestClient

import conftest
from conftest import AUTH_TOKEN, TestCaptureRuntimeClient, minimal_pdf
from llm_test_fakes import RecordingOllamaClient
from cert_prep_backend.api.app import create_app
from cert_prep_backend.ai_providers.infrastructure.ollama_transport import OllamaProvider
from cert_prep_backend.authoring.domain.models import DraftGenerationStrategy
from cert_prep_backend.authoring.infrastructure import repository as drafts_repository
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.practice.infrastructure.repository import SqlitePracticeRepository


@pytest.mark.parametrize("dictionary_enabled", [True, False])
def test_mixed_pages_are_saved_with_actual_model_attribution(tmp_path, monkeypatch, dictionary_enabled):
    # Invented text exercises dictionary completion and a damaged unnumbered layout.
    parsed = "問題1 漢字の読み方を選びなさい。\n5 機械を直した。\n1 きかい 2 きがい 3 きけい 4 きこう"
    unparsed = "Choose a widget: Which widget is blue? alpha blue | beta red | gamma green | delta yellow"
    monkeypatch.setattr(conftest, "_fake_source_pages", lambda *_args: [parsed, unparsed])
    fake_client = RecordingOllamaClient(models=["qwen3.5:4b"], chat_content=json.dumps({
        "answer": "1", "rationale": "The source supports the first choice.", "confidence": 0.8,
        "items": [{
            "citation_page": 2, "question": "Which widget is blue?",
            "choices": ["alpha blue", "beta red", "gamma green", "delta yellow"],
            "answer": "alpha blue", "rationale": "The blue widget is alpha.",
            "confidence": 0.8, "source_excerpt": unparsed,
        }],
    }))
    provider = OllamaProvider("http://127.0.0.1:11434", "qwen3.5:4b", 1, client=fake_client)
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
    with TestClient(create_app(
        settings=Settings(data_dir=tmp_path, api_token=AUTH_TOKEN,
                          reading_solver_enabled=dictionary_enabled),
        llm_provider=provider, capture_runtime_client=TestCaptureRuntimeClient(),
        document_processing_async_jobs=False, streaming_draft_generation_async_jobs=False,
    )) as client:
        project_id = client.post("/projects", headers=headers, json={"name": "Widgets"}).json()["id"]
        response = client.post(
            f"/projects/{project_id}/documents", headers=headers,
            files={"file": ("widgets.pdf", minimal_pdf("Synthetic widgets."), "application/pdf")},
        )
        assert response.status_code == 201
        document_id = response.json()["id"]
        database = client.app.state.database
        operation = client.app.state.streaming_draft_generation_manager.start_manual_operation(
            database, project_id=project_id, document_id=document_id, limit=2,
            strategy=DraftGenerationStrategy.HYBRID_REASONING,
        )
        assert operation.status == "succeeded"
        assert operation.effective_provider == "ollama"
        assert operation.effective_model == "qwen3.5:4b"
        suggestions = drafts_repository.list_drafts(database, project_id)
        assert sorted(item.citation_page for item in suggestions) == [1, 2]
        reasoned = next(item for item in suggestions if item.citation_page == 2)
        assert reasoned.answer == "alpha blue"
        assert reasoned.rationale == "The blue widget is alpha."
        parsed_draft = next(item for item in suggestions if item.citation_page == 1)
        assert parsed_draft.answer == "1 きかい"
        assert parsed_draft.confidence == (1.0 if dictionary_enabled else 0.8)
        assert len(fake_client.chat_calls) == (1 if dictionary_enabled else 2)
        reasoning_call = fake_client.chat_calls[-1]
        assert unparsed in reasoning_call["messages"][-1]["content"]
        assert parsed not in reasoning_call["messages"][-1]["content"]
    assert fake_client.pull_calls == 0


def test_mixed_pages_preserve_saved_and_practice_order(tmp_path, monkeypatch):
    parsed = (
        "Mondai 1 Choose the correct word. 5 Which widget is correct? "
        "1 alpha 2 beta 3 gamma 4 delta"
    )
    # Extraction must quote the page, so both stems appear in the damaged layout.
    unparsed = (
        "Choose from the damaged layout. Which widget is blue? Which widget is red? "
        "alpha | beta | gamma | delta"
    )
    monkeypatch.setattr(conftest, "_fake_source_pages", lambda *_args: [parsed, unparsed])
    fake_client = RecordingOllamaClient(models=["qwen3.5:4b"], chat_content=json.dumps({
        "answer": "1", "rationale": "The source supports alpha.", "confidence": 0.8,
        "items": [
            {
                "citation_page": 2, "question": f"Which widget is {color}?",
                "choices": ["alpha", "beta", "gamma", "delta"],
                "answer": "alpha", "rationale": "The source supports alpha.",
                "confidence": 0.8, "source_excerpt": unparsed,
            }
            for color in ("blue", "red")
        ],
    }))
    provider = OllamaProvider("http://127.0.0.1:11434", "qwen3.5:4b", 1, client=fake_client)
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
    with TestClient(create_app(
        settings=Settings(
            data_dir=tmp_path, api_token=AUTH_TOKEN, reading_solver_enabled=False,
        ),
        llm_provider=provider, capture_runtime_client=TestCaptureRuntimeClient(),
        document_processing_async_jobs=False, streaming_draft_generation_async_jobs=False,
    )) as client:
        project_id = client.post("/projects", headers=headers, json={"name": "Widgets"}).json()["id"]
        response = client.post(
            f"/projects/{project_id}/documents", headers=headers,
            files={"file": ("widgets.pdf", minimal_pdf("Synthetic widgets."), "application/pdf")},
        )
        assert response.status_code == 201
        document_id = response.json()["id"]
        database = client.app.state.database
        operation = client.app.state.streaming_draft_generation_manager.start_manual_operation(
            database, project_id=project_id, document_id=document_id, limit=3,
            strategy=DraftGenerationStrategy.HYBRID_REASONING,
        )
        assert operation.status == "succeeded"
        drafts = sorted(
            drafts_repository.list_drafts(database, project_id), key=lambda item: item.source_order
        )
        assert [item.citation_page for item in drafts] == [1, 2, 2]
        assert [item.source_order for item in drafts] == [10001, 21001, 21002]
        assert [item.question for item in drafts[1:]] == [
            "Which widget is blue?", "Which widget is red?"
        ]
        with database.connect() as connection:
            questions = SqlitePracticeRepository(connection).approved_questions(
                project_id, document_id=document_id
            )
        assert [item.id for item in questions] == [item.id for item in drafts]
    assert fake_client.pull_calls == 0
