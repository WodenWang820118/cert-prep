from collections.abc import Sequence
from threading import Event

from fastapi.testclient import TestClient

from exam_prep_backend.app import create_app
from exam_prep_backend.config import Settings
from exam_prep_backend.domains.mock_exams.models import DraftSuggestion, SourceChunk
from exam_prep_backend.domains.mock_exams.ports import ModelPullProgress, ProviderHealth
from exam_prep_backend.domains.mock_exams.provider import (
    MAX_PROMPT_SOURCE_CHARS,
    _draft_suggestion_from_item,
    _extract_jlpt_question_blocks,
    _source_text_for_prompt,
)


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
        },
        {3: chunk},
        {"chunk-2": chunk},
    )

    assert suggestion is not None
    assert suggestion.answer == "1 seikai"
    assert suggestion.citation_page == 3


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


def test_jlpt_question_blocks_extract_as_manual_drafts_without_ai() -> None:
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
    assert suggestions[0].status.value == "draft"
    assert suggestions[0].citation_page == 2


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
        "model": "gemma4:12b",
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
        },
        {1: chunk},
        {"chunk-1": chunk},
    )

    assert suggestion is None


class RecordingDownloadProvider:
    provider = "ollama"
    model = "gemma4:12b"

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
