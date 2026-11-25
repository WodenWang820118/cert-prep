from unittest.mock import MagicMock, Mock

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
    server = Mock()
    adapter = source_library_links.chunk_translator(db, settings, server=server)
    factory.assert_not_called()
    args = ('project', 'document') if batch else ('project', 'document', 'chunk')

    for _ in range(2):
        assert getattr(adapter, name)(*args) is operation.return_value

    expected = {'server': server, 'keep_alive': '5m'} if batch else {'server': server}
    assert factory.call_count == 2
    for call in factory.call_args_list:
        assert call.args == (settings,)
        assert call.kwargs == expected
    first, second = operation.call_args_list
    assert first.args == second.args == (db,)
    assert first.kwargs['translator'] is not second.kwargs['translator']


@pytest.mark.parametrize('language_hint', ['en', 'ja'])
def test_chunk_translation_uses_its_recording_language_hint(monkeypatch, language_hint):
    document = Mock(language_hint=language_hint)
    chunk = Mock(text='Transcript', source_revision=2)
    monkeypatch.setattr(audio.documents, 'get_document', Mock(return_value=document))
    monkeypatch.setattr(audio.chunks, 'get_chunk', Mock(return_value=chunk))
    save_translation = Mock()
    monkeypatch.setattr(audio.chunks, 'compare_and_set_chunk_translation', save_translation)
    translator = Mock()
    translator.translate.return_value = 'Translation'
    db = Mock()
    db.connect.return_value = MagicMock()
    connection = db.connect.return_value.__enter__.return_value

    result = audio.translate_chunk(
        db,
        translator=translator,
        project_id='project',
        document_id='document',
        chunk_id='chunk',
        reconcile_document_status=False,
    )

    assert result is chunk
    translator.translate.assert_called_once_with(chunk.text, source_language=language_hint)
    save_translation.assert_called_once_with(
        connection,
        project_id='project',
        document_id='document',
        chunk_id='chunk',
        translated_text='Translation',
        expected_source_revision=2,
    )
