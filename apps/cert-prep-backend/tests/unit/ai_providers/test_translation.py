from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from cert_prep_backend.ai_providers.infrastructure import translation
from cert_prep_backend.platform.config import Settings


@pytest.mark.parametrize('keep_alive', [0, '5m'])
@pytest.mark.parametrize('content, expected', [('  譯文  ', '譯文'), (None, '')])
def test_translation_preserves_model_request(monkeypatch, keep_alive, content, expected):
    client = Mock()
    client.chat.return_value = SimpleNamespace(message=SimpleNamespace(content=content))
    factory = Mock(return_value=client)
    monkeypatch.setattr(translation, 'Client', factory)
    settings = Settings(ollama_host='http://localhost:1234', ollama_timeout_seconds=37)
    translator = translation.OllamaTraditionalChineseTranslator(settings, keep_alive=keep_alive)

    assert translator.translate('原文') == expected
    factory.assert_called_once_with(host=settings.ollama_host, timeout=37)
    client.chat.assert_called_once_with(
        model=settings.ollama_model,
        messages=[
            {
                'role': 'system',
                'content': (
                    'Translate Japanese into natural Traditional Chinese used in Taiwan. '
                    'Return only the translation. Preserve names, numbers, and meaning.'
                ),
            },
            {'role': 'user', 'content': '原文'},
        ],
        options={'temperature': 0, 'num_ctx': 2048, 'num_predict': 512},
        think=False,
        stream=False,
        keep_alive=keep_alive,
    )
    translator.release_resources()
    translator.release_resources()
    if keep_alive == 0:
        client.generate.assert_not_called()
    else:
        client.generate.assert_called_once_with(model=settings.ollama_model, keep_alive=0)


def test_translation_propagates_model_errors(monkeypatch):
    client = Mock()
    failure = RuntimeError('model unavailable')
    client.chat.side_effect = failure
    monkeypatch.setattr(translation, 'Client', Mock(return_value=client))

    with pytest.raises(RuntimeError) as raised:
        translation.OllamaTraditionalChineseTranslator(Settings()).translate('原文')
    assert raised.value is failure
