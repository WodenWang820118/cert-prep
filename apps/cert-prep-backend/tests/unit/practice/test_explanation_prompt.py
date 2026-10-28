"""Discuss mistake with AI asks for a Traditional Chinese explanation."""

from cert_prep_backend.ai_providers.domain.provider import ProviderHealth
from cert_prep_backend.platform.errors import ProviderUnavailableError
from cert_prep_backend.practice.application.explanations import (
    EXPLANATION_LANGUAGE_INSTRUCTION,
    WrongAnswerGroundedFields,
    explain_wrong_answer,
    explanation_prompt,
)
from cert_prep_backend.practice.domain.wrong_answer import WrongAnswer


def _wrong_answer() -> WrongAnswer:
    return WrongAnswer(
        attempt_id="attempt-1",
        session_id="session-1",
        question_id="question-1",
        question="余暇の楽しみ方は？",
        choices=("ようか", "よか"),
        selected_answer="ようか",
        correct_answer="よか",
        rationale="読みは「よか」。",
        citation_page=2,
        source_excerpt="余暇",
        document_id="document-1",
        created_at="2026-06-11T00:00:00Z",
    )


def _health(*, available: bool, provider: str = "ollama") -> ProviderHealth:
    return ProviderHealth(
        provider=provider,
        model="test-model",
        available=available,
        detail="ok" if available else "down",
    )


class RecordingJsonProvider:
    provider = "ollama"
    model = "test-model"

    def __init__(self, reply: str) -> None:
        self.reply = reply
        self.messages: list[object] = []
        self.kwargs: list[dict[str, object]] = []

    def health(self) -> ProviderHealth:
        return _health(available=True)

    def json_chat_session(self, operation):
        def chat(messages, **kwargs):
            self.messages.append(messages)
            self.kwargs.append(kwargs)
            return self.reply

        return operation(chat)


class DirectExplanationProvider(RecordingJsonProvider):
    def explain_wrong_answer(self, _fields) -> str:
        return "直接解說。"


def test_explanation_prompt_requires_traditional_chinese() -> None:
    prompt = explanation_prompt(WrongAnswerGroundedFields.from_wrong_answer(_wrong_answer()))

    assert EXPLANATION_LANGUAGE_INSTRUCTION == (
        "Write the explanation in Traditional Chinese (繁體中文) as used in Taiwan, "
        "and quote words from the source, such as the Japanese word being read, "
        "in their original script."
    )
    assert EXPLANATION_LANGUAGE_INSTRUCTION in prompt
    assert "余暇の楽しみ方は？" in prompt
    assert '"explanation"' not in prompt
    assert "field named explanation" in prompt


def test_an_available_model_receives_the_traditional_chinese_prompt() -> None:
    provider = RecordingJsonProvider('{"explanation":" 選項與正解不符，原文是「読む」。 "}')

    result = explain_wrong_answer(provider, _wrong_answer())

    assert result.fallback is False
    assert result.explanation == "選項與正解不符，原文是「読む」。"
    assert result.provider == "ollama"
    sent = provider.messages[0][0]["content"]
    assert EXPLANATION_LANGUAGE_INSTRUCTION in sent
    assert provider.kwargs == [{"num_ctx": 2048, "num_predict": 512}]


def test_plain_model_text_is_kept_when_it_is_not_json() -> None:
    provider = RecordingJsonProvider("選項與正解不符，原文是「読む」。")

    result = explain_wrong_answer(provider, _wrong_answer())

    assert result.fallback is False
    assert result.explanation == "選項與正解不符，原文是「読む」。"


def test_an_empty_model_explanation_falls_back_to_the_fixed_english_text() -> None:
    provider = RecordingJsonProvider('{"explanation":"  "}')

    result = explain_wrong_answer(provider, _wrong_answer())

    assert result.fallback is True
    assert "Allow unrestricted access" not in result.explanation
    assert "ようか" in result.explanation
    assert "よか" in result.explanation


def test_a_provider_that_explains_directly_is_not_sent_the_json_chat() -> None:
    provider = DirectExplanationProvider("unused")

    result = explain_wrong_answer(provider, _wrong_answer())

    assert result.explanation == "直接解說。"
    assert result.fallback is False
    assert provider.messages == []


def test_an_unavailable_provider_keeps_the_english_fallback() -> None:
    class DownProvider:
        provider = "ollama"
        model = "test-model"

        def health(self) -> ProviderHealth:
            return _health(available=False)

        def json_chat_session(self, _operation):
            raise AssertionError("an unavailable provider must not be prompted")

    result = explain_wrong_answer(DownProvider(), _wrong_answer())

    assert result.fallback is True
    assert "ようか" in result.explanation


def test_a_failed_json_chat_falls_back() -> None:
    class FailingProvider(RecordingJsonProvider):
        def json_chat_session(self, _operation):
            raise ProviderUnavailableError("model stopped")

    result = explain_wrong_answer(FailingProvider("unused"), _wrong_answer())

    assert result.fallback is True
