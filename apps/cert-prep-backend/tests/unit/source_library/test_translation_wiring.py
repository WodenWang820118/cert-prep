from unittest.mock import Mock

import pytest

from cert_prep_backend.bootstrap import source_library_links
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.source_library.infrastructure import audio


@pytest.mark.parametrize('batch', [False, True])
def test_bootstrap_supplies_fresh_translator_for_each_operation(monkeypatch, batch):
    factory = Mock(side_effect=[Mock(), Mock()])
    monkeypatch.setattr(source_library_links, 'OllamaTraditionalChineseTranslator', factory)
    operation = Mock(return_value=[] if batch else Mock())
    name = 'translate_stale_chunks' if batch else 'translate_chunk'
    monkeypatch.setattr(audio, name, operation)
    db = Mock()
    settings = Settings()
    adapter = source_library_links.chunk_translator(db, settings)
    factory.assert_not_called()
    args = ('project', 'document') if batch else ('project', 'document', 'chunk')

    for _ in range(2):
        assert getattr(adapter, name)(*args) is operation.return_value

    expected = {'keep_alive': '5m'} if batch else {}
    assert factory.call_count == 2
    for call in factory.call_args_list:
        assert call.args == (settings,)
        assert call.kwargs == expected
    first, second = operation.call_args_list
    assert first.args == second.args == (db,)
    assert first.kwargs['translator'] is not second.kwargs['translator']
