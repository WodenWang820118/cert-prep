"""Capture review use cases call their ports in the order the router used to."""

from __future__ import annotations

import hashlib

import pytest

from cert_prep_backend.capture_integration.application import use_cases
from cert_prep_backend.capture_integration.application.errors import (
    CaptureAudioRejected,
    CaptureExtractionCanceled,
    CaptureExtractionFailed,
    CaptureRequirementUnavailable,
)
from cert_prep_backend.capture_integration.application.messages import PDF_OCR_UNAVAILABLE_MESSAGE
from cert_prep_backend.capture_integration.domain.review_session import (
    CaptureReviewSession,
    CaptureReviewStatus,
)
from cert_prep_backend.platform.errors import DocumentOperationConflictError, NotFoundError
from cert_prep_backend.source_library.domain.document import SourceDocument, SourceFile
from cert_prep_backend.source_library.domain.operation import DocumentOperation
from cert_prep_backend.source_library.domain.statuses import (
    DocumentOperationPhase,
    DocumentOperationStatus,
)

PROJECT = "project"
OPERATION = "operation"
CONTENT = b"page-bytes"
DIGEST = hashlib.sha256(CONTENT).hexdigest()
STORED = "stored/path"
CREATION_FAILED = "Capture review creation failed."
EXTRACTION_FAILED = "Capture Runtime extraction failed."
AUDIO_REJECTED = "Capture review supports PDF and image sources only."


class Prepared:
    def __init__(self, kind: str, canonical_suffix: str, page_count: int) -> None:
        self.kind = kind
        self.canonical_suffix = canonical_suffix
        self.page_count = page_count


def source_document(filename: str = "scan.png") -> SourceDocument:
    return SourceDocument(
        id="document",
        project_id=PROJECT,
        filename=filename,
        sha256=DIGEST,
        language_hint="auto",
        page_count=2,
        has_text=False,
        status="uploaded",
        extraction_method="none",
        ocr_device=None,
        ocr_fallback_reason=None,
        ocr_duration_ms=0,
        processed_page_count=0,
        parse_wall_duration_ms=0,
        render_duration_ms=0,
        ocr_engine_duration_ms=0,
        ocr_worker_count=0,
        first_chunk_ms=0,
        exam_item_count=0,
        content_profile="unknown",
        classification_detail="",
        chunks_count=0,
        created_at="t",
        updated_at="t",
    )


def review_session() -> CaptureReviewSession:
    return CaptureReviewSession(
        id="session",
        project_id=PROJECT,
        document_id="document",
        operation_id=OPERATION,
        runtime_capture_id=None,
        status=CaptureReviewStatus.PENDING,
        review_revision=0,
        expires_at="later",
        created_at="t",
        updated_at="t",
        confirm_request_id=None,
        confirm_review_digest=None,
        last_event_sequence=0,
    )


def running_operation(status: DocumentOperationStatus) -> DocumentOperation:
    return DocumentOperation(
        OPERATION,
        PROJECT,
        "document",
        status,
        DocumentOperationPhase.PROCESSING,
        True,
        None,
        "t",
        "t",
    )


class FakeProjects:
    def __init__(self, trace: list[tuple], *, missing: bool = False) -> None:
        self.trace = trace
        self.missing = missing

    def get(self, project_id: str):
        self.trace.append(("project", project_id))
        if self.missing:
            return None
        return object()


class FakeDocuments:
    def __init__(self, trace: list[tuple], source: SourceFile) -> None:
        self.trace = trace
        self.source = source
        self.document_filename = "scan.png"
        self.document_error: BaseException | None = None
        self.source_error: BaseException | None = None

    def document(self, project_id: str, document_id: str) -> SourceDocument:
        self.trace.append(("document", project_id, document_id))
        if self.document_error is not None:
            raise self.document_error
        return source_document(self.document_filename)

    def source_file(self, project_id: str, document_id: str) -> SourceFile:
        self.trace.append(("source_file", project_id, document_id))
        if self.source_error is not None:
            raise self.source_error
        return self.source

    def attach_document(
        self,
        project_id: str,
        operation_id: str,
        *,
        filename: str,
        sha256: str,
        language_hint: str,
        storage_path: str,
        page_count: int,
    ) -> SourceDocument:
        self.trace.append(
            (
                "attach",
                project_id,
                operation_id,
                filename,
                sha256,
                language_hint,
                storage_path,
                page_count,
            )
        )
        return source_document(filename)


class FakeOperations:
    def __init__(self, trace: list[tuple], *, acquired: bool = True) -> None:
        self.trace = trace
        self.acquired = acquired
        self.status = DocumentOperationStatus.RUNNING
        self.claim_error: BaseException | None = None
        self.fail_error: BaseException | None = None
        self.cancel_error: BaseException | None = None
        self.acknowledge_error: BaseException | None = None
        self.operation_error: BaseException | None = None

    def claim_upload(self, project_id: str, operation_id: str) -> bool:
        self.trace.append(("claim_upload", project_id, operation_id))
        if self.claim_error is not None:
            raise self.claim_error
        return self.acquired

    def fail(self, project_id: str, operation_id: str, *, error: str) -> DocumentOperation:
        self.trace.append(("fail", project_id, operation_id, error))
        if self.fail_error is not None:
            raise self.fail_error
        return running_operation(DocumentOperationStatus.FAILED)

    def cancel(self, project_id: str, operation_id: str) -> DocumentOperation:
        self.trace.append(("cancel", project_id, operation_id))
        if self.cancel_error is not None:
            raise self.cancel_error
        return running_operation(DocumentOperationStatus.CANCELED)

    def acknowledge_cancellation(self, project_id: str, operation_id: str) -> DocumentOperation:
        self.trace.append(("acknowledge", project_id, operation_id))
        if self.acknowledge_error is not None:
            raise self.acknowledge_error
        return running_operation(DocumentOperationStatus.CANCELED)

    def operation(self, project_id: str, operation_id: str) -> DocumentOperation:
        self.trace.append(("operation", project_id, operation_id))
        if self.operation_error is not None:
            raise self.operation_error
        return running_operation(self.status)


class FakeFiles:
    def __init__(self, trace: list[tuple], prepared: Prepared) -> None:
        self.trace = trace
        self.prepared = prepared
        self.prepare_error: BaseException | None = None
        self.read_error: BaseException | None = None
        self.content = b"stored-bytes"

    def prepare(
        self,
        content: bytes,
        *,
        max_pdf_pages: int,
        max_image_pixels: int,
        filename: str | None,
    ) -> Prepared:
        self.trace.append(("prepare", content, max_pdf_pages, max_image_pixels, filename))
        if self.prepare_error is not None:
            raise self.prepare_error
        return self.prepared

    def store(
        self,
        *,
        project_id: str,
        sha256: str,
        content: bytes,
        canonical_suffix: str,
    ) -> str:
        self.trace.append(("store", project_id, sha256, content, canonical_suffix))
        return STORED

    def read_bytes(self, storage_path: str) -> bytes:
        self.trace.append(("read_bytes", storage_path))
        if self.read_error is not None:
            raise self.read_error
        return self.content


class FakeSessions:
    def __init__(self, trace: list[tuple], session: CaptureReviewSession) -> None:
        self.trace = trace
        self.session = session
        self.finish_error: BaseException | None = None

    def create(
        self, *, project_id: str, document_id: str, operation_id: str
    ) -> CaptureReviewSession:
        self.trace.append(("create", project_id, document_id, operation_id))
        return self.session

    def finish(
        self,
        *,
        project_id: str,
        session_id: str,
        status: CaptureReviewStatus,
        terminal_sequence: int | None = None,
    ) -> CaptureReviewSession:
        self.trace.append(("finish", project_id, session_id, status, terminal_sequence))
        if self.finish_error is not None:
            raise self.finish_error
        return self.session


class FakeWorkflow:
    def __init__(self, trace: list[tuple]) -> None:
        self.trace = trace
        self.error: BaseException | None = None
        self.should_cancel = None
        self.on_runtime_started = None

    def begin_review(self, **kwargs) -> None:
        self.should_cancel = kwargs["should_cancel"]
        self.on_runtime_started = kwargs["on_runtime_started"]
        self.trace.append(
            (
                "begin",
                kwargs["project_id"],
                kwargs["document_id"],
                kwargs["operation_id"],
                kwargs["session_id"],
                kwargs["file_name"],
                kwargs["content"],
                kwargs["media_type"],
                kwargs["source_kind"],
            )
        )
        if self.error is not None:
            raise self.error


class FakeWork:
    def __init__(self, trace: list[tuple]) -> None:
        self.trace = trace
        self.closed = False
        self.submit_error: BaseException | None = None
        self.run = None
        self.cancel_queued = None

    def submit(self, *, operation_id: str, run, cancel_queued) -> None:
        self.trace.append(("submit", operation_id))
        self.run = run
        self.cancel_queued = cancel_queued
        if self.submit_error is not None:
            raise self.submit_error

    def is_closed(self) -> bool:
        self.trace.append(("is_closed", self.closed))
        return self.closed


class FakeEvents:
    def __init__(self, trace: list[tuple]) -> None:
        self.trace = trace

    def publish_runtime(self, project_id: str, session_id: str, runtime_id: str) -> None:
        self.trace.append(("publish_runtime", project_id, session_id, runtime_id))

    def publish_terminal(self, project_id: str, session_id: str, terminal: str) -> None:
        self.trace.append(("publish_terminal", project_id, session_id, terminal))

    def publish_review_ready(self, project_id: str, session_id: str) -> None:
        self.trace.append(("publish_review_ready", project_id, session_id))


class FakeMaintenance:
    def __init__(self, trace: list[tuple]) -> None:
        self.trace = trace

    def expire(self) -> tuple[str, ...]:
        self.trace.append(("expire",))
        return ("session",)

    def recover(self) -> tuple[str, ...]:
        self.trace.append(("recover",))
        return ("session",)


class World:
    def __init__(self) -> None:
        self.trace: list[tuple] = []
        self.prepared = Prepared("image", ".png", 4)
        self.source = SourceFile("scan.png", DIGEST, "uploads/scan.png")
        self.projects = FakeProjects(self.trace)
        self.documents = FakeDocuments(self.trace, self.source)
        self.operations = FakeOperations(self.trace)
        self.files = FakeFiles(self.trace, self.prepared)
        self.sessions = FakeSessions(self.trace, review_session())
        self.workflow = FakeWorkflow(self.trace)
        self.work = FakeWork(self.trace)
        self.events = FakeEvents(self.trace)
        self.maintenance = FakeMaintenance(self.trace)


def claim(world: World):
    return use_cases.claim_capture_upload(
        world.projects,
        world.operations,
        project_id=PROJECT,
        operation_id=OPERATION,
    )


def start(world: World, *, filename: str | None = "scan.png", content: bytes = CONTENT):
    return use_cases.start_capture_review(
        world.sessions,
        world.documents,
        world.operations,
        world.files,
        world.workflow,
        world.work,
        world.events,
        project_id=PROJECT,
        operation_id=OPERATION,
        filename=filename,
        content=content,
        max_pdf_pages=12,
        max_image_pixels=40,
    )


def extract(world: World) -> None:
    use_cases.extract_capture_for_review(
        world.documents,
        world.operations,
        world.files,
        world.sessions,
        world.workflow,
        world.work,
        world.events,
        project_id=PROJECT,
        document_id="document",
        operation_id=OPERATION,
        session_id="session",
    )


def accepted_prefix(filename: str | None, attached_name: str) -> list[tuple]:
    return [
        ("prepare", CONTENT, 12, 40, filename),
        ("store", PROJECT, DIGEST, CONTENT, ".png"),
        ("attach", PROJECT, OPERATION, attached_name, DIGEST, "auto", STORED, 4),
        ("create", PROJECT, "document", OPERATION),
        ("submit", OPERATION),
    ]


def test_public_use_cases_are_the_review_lifecycle_names() -> None:
    assert use_cases.__all__ == [
        "abandon_capture_upload",
        "claim_capture_upload",
        "expire_capture_reviews",
        "extract_capture_for_review",
        "finish_canceled_capture",
        "recover_capture_reviews",
        "start_capture_review",
    ]


def test_a_reused_operation_id_does_not_prepare_or_open_a_session() -> None:
    world = World()
    world.operations.acquired = False

    claimed = claim(world)

    assert claimed.acquired is False
    assert claimed.operation_id == OPERATION
    assert world.trace == [("project", PROJECT), ("claim_upload", PROJECT, OPERATION)]


def test_a_missing_project_is_not_found_before_the_claim() -> None:
    world = World()
    world.projects.missing = True

    with pytest.raises(NotFoundError, match="Project not found."):
        claim(world)

    assert world.trace == [("project", PROJECT)]


def test_a_cross_project_operation_conflict_propagates() -> None:
    world = World()
    world.operations.claim_error = DocumentOperationConflictError(
        "Document operation id is already in use."
    )

    with pytest.raises(DocumentOperationConflictError, match="already in use"):
        claim(world)

    assert world.trace == [("project", PROJECT), ("claim_upload", PROJECT, OPERATION)]


def test_audio_is_rejected_after_prepare_and_abandons_without_a_session() -> None:
    world = World()
    world.prepared.kind = "audio"

    with pytest.raises(CaptureAudioRejected) as caught:
        start(world)

    assert str(caught.value) == AUDIO_REJECTED
    assert world.trace == [
        ("prepare", CONTENT, 12, 40, "scan.png"),
        ("fail", PROJECT, OPERATION, CREATION_FAILED),
    ]


def test_a_prepare_failure_abandons_the_claim_without_a_session() -> None:
    world = World()
    world.files.prepare_error = RuntimeError("unreadable")

    with pytest.raises(RuntimeError, match="unreadable"):
        start(world)

    assert world.trace == [
        ("prepare", CONTENT, 12, 40, "scan.png"),
        ("fail", PROJECT, OPERATION, CREATION_FAILED),
    ]


def test_an_accepted_upload_stores_attaches_and_submits_in_order() -> None:
    world = World()

    started = start(world)

    assert world.trace == accepted_prefix("scan.png", "scan.png")
    assert ("is_closed", True) not in world.trace
    assert ("is_closed", False) not in world.trace
    assert started.content_length == len(CONTENT)
    assert started.canonical_suffix == ".png"
    assert started.document.filename == "scan.png"
    assert started.session.id == "session"


def test_a_missing_filename_falls_back_to_the_digest_and_suffix() -> None:
    world = World()

    started = start(world, filename=None)

    assert world.trace == accepted_prefix(None, f"{DIGEST}.png")
    assert started.document.filename == f"{DIGEST}.png"
    assert started.content_length == len(CONTENT)
    assert started.canonical_suffix == ".png"


def test_submit_failure_fails_the_operation_then_the_session_and_reraises() -> None:
    world = World()
    world.work.submit_error = RuntimeError("pool closed")

    with pytest.raises(RuntimeError, match="pool closed"):
        start(world)

    assert world.trace == [
        *accepted_prefix("scan.png", "scan.png"),
        ("fail", PROJECT, OPERATION, CREATION_FAILED),
        ("finish", PROJECT, "session", CaptureReviewStatus.FAILED, None),
        ("publish_terminal", PROJECT, "session", CaptureReviewStatus.FAILED),
    ]


def test_a_failure_to_mark_the_operation_is_swallowed_and_the_session_still_ends() -> None:
    world = World()
    world.work.submit_error = RuntimeError("pool closed")
    world.operations.fail_error = RuntimeError("disk")

    with pytest.raises(RuntimeError, match="pool closed"):
        start(world)

    assert ("fail", PROJECT, OPERATION, CREATION_FAILED) in world.trace
    assert ("finish", PROJECT, "session", CaptureReviewStatus.FAILED, None) in world.trace
    assert ("publish_terminal", PROJECT, "session", CaptureReviewStatus.FAILED) in world.trace


def test_a_failure_to_finish_the_session_is_swallowed() -> None:
    world = World()
    world.work.submit_error = RuntimeError("pool closed")
    world.sessions.finish_error = RuntimeError("no row")

    with pytest.raises(RuntimeError, match="pool closed"):
        start(world)

    assert ("finish", PROJECT, "session", CaptureReviewStatus.FAILED, None) in world.trace
    assert not any(item[0] == "publish_terminal" for item in world.trace)


def test_abandon_without_a_session_does_not_finish_one() -> None:
    world = World()

    use_cases.abandon_capture_upload(
        world.sessions,
        world.operations,
        world.events,
        project_id=PROJECT,
        operation_id=OPERATION,
        session_id=None,
    )

    assert world.trace == [("fail", PROJECT, OPERATION, CREATION_FAILED)]


def test_a_document_load_stays_outside_extraction_failure_handling() -> None:
    world = World()
    world.documents.document_error = CaptureExtractionFailed("requirement_unavailable", 9)

    with pytest.raises(CaptureExtractionFailed) as caught:
        extract(world)

    assert caught.value.code == "requirement_unavailable"
    assert caught.value.terminal_sequence == 9
    assert world.trace == [("document", PROJECT, "document")]


def test_pdf_requirement_failure_uses_the_pdf_message_and_no_sequence() -> None:
    world = World()
    world.source = SourceFile("notes.bin", DIGEST, "uploads/notes.PDF")
    world.documents.source = world.source
    world.workflow.error = CaptureRequirementUnavailable("windowsml down")

    extract(world)

    assert world.trace == [
        ("document", PROJECT, "document"),
        ("source_file", PROJECT, "document"),
        ("read_bytes", "uploads/notes.PDF"),
        (
            "begin",
            PROJECT,
            "document",
            OPERATION,
            "session",
            "scan.png",
            b"stored-bytes",
            "application/pdf",
            "pdf",
        ),
        ("finish", PROJECT, "session", CaptureReviewStatus.FAILED, None),
        ("fail", PROJECT, OPERATION, PDF_OCR_UNAVAILABLE_MESSAGE),
        ("publish_terminal", PROJECT, "session", CaptureReviewStatus.FAILED),
    ]


def test_image_requirement_failure_uses_the_runtime_message() -> None:
    world = World()
    world.workflow.error = CaptureRequirementUnavailable("decoder missing")

    extract(world)

    assert world.trace[-4] == (
        "begin",
        PROJECT,
        "document",
        OPERATION,
        "session",
        "scan.png",
        b"stored-bytes",
        "image/png",
        "image",
    )
    assert world.trace[-3:] == [
        ("finish", PROJECT, "session", CaptureReviewStatus.FAILED, None),
        ("fail", PROJECT, OPERATION, "decoder missing"),
        ("publish_terminal", PROJECT, "session", CaptureReviewStatus.FAILED),
    ]


def test_a_pdf_requirement_job_keeps_the_pdf_message_and_the_sequence() -> None:
    world = World()
    world.source = SourceFile("notes.pdf", DIGEST, "uploads/blob")
    world.documents.source = world.source
    world.documents.document_filename = "notes.pdf"
    world.workflow.error = CaptureExtractionFailed("requirement_unavailable", 8)

    extract(world)

    assert (
        "begin",
        PROJECT,
        "document",
        OPERATION,
        "session",
        "notes.pdf",
        b"stored-bytes",
        "application/pdf",
        "pdf",
    ) in world.trace
    assert world.trace[-3:] == [
        ("finish", PROJECT, "session", CaptureReviewStatus.FAILED, 8),
        ("fail", PROJECT, OPERATION, PDF_OCR_UNAVAILABLE_MESSAGE),
        ("publish_terminal", PROJECT, "session", CaptureReviewStatus.FAILED),
    ]


def test_any_other_job_code_uses_the_generic_message_and_the_sequence() -> None:
    world = World()
    world.source = SourceFile("notes.pdf", DIGEST, "uploads/notes.pdf")
    world.documents.source = world.source
    world.workflow.error = CaptureExtractionFailed("capture_failed", 3)

    extract(world)

    assert world.trace[-3:] == [
        ("finish", PROJECT, "session", CaptureReviewStatus.FAILED, 3),
        ("fail", PROJECT, OPERATION, EXTRACTION_FAILED),
        ("publish_terminal", PROJECT, "session", CaptureReviewStatus.FAILED),
    ]


def test_a_generic_extraction_failure_has_no_terminal_sequence() -> None:
    world = World()
    world.workflow.error = RuntimeError("socket down")

    extract(world)

    assert world.trace[-3:] == [
        ("finish", PROJECT, "session", CaptureReviewStatus.FAILED, None),
        ("fail", PROJECT, OPERATION, EXTRACTION_FAILED),
        ("publish_terminal", PROJECT, "session", CaptureReviewStatus.FAILED),
    ]


def test_a_stored_file_read_is_inside_the_failure_path() -> None:
    world = World()
    world.files.read_error = OSError("gone")

    extract(world)

    assert [item[0] for item in world.trace] == [
        "document",
        "source_file",
        "read_bytes",
        "finish",
        "fail",
        "publish_terminal",
    ]
    assert ("fail", PROJECT, OPERATION, EXTRACTION_FAILED) in world.trace
    assert ("finish", PROJECT, "session", CaptureReviewStatus.FAILED, None) in world.trace


def test_a_canceled_extraction_acknowledges_then_cancels_the_session() -> None:
    world = World()
    world.workflow.error = CaptureExtractionCanceled()

    extract(world)

    assert [item[0] for item in world.trace] == [
        "document",
        "source_file",
        "read_bytes",
        "begin",
        "acknowledge",
        "finish",
        "publish_terminal",
    ]
    assert ("finish", PROJECT, "session", CaptureReviewStatus.CANCELED, None) in world.trace
    assert ("publish_terminal", PROJECT, "session", CaptureReviewStatus.CANCELED) in world.trace
    assert not any(item[0] == "fail" for item in world.trace)


def test_a_successful_extraction_publishes_review_ready_only() -> None:
    world = World()

    extract(world)

    assert ("publish_review_ready", PROJECT, "session") in world.trace
    assert not any(item[0] in {"finish", "fail", "publish_terminal"} for item in world.trace)
    assert world.trace[-1] == ("publish_review_ready", PROJECT, "session")


def test_should_cancel_when_the_pool_is_closed_or_the_operation_is_not_running() -> None:
    world = World()
    extract(world)
    cancel = world.workflow.should_cancel
    assert cancel is not None

    world.work.closed = True
    assert cancel() is True
    assert not any(item[0] == "operation" for item in world.trace)

    world.work.closed = False
    assert cancel() is False
    assert ("operation", PROJECT, OPERATION) in world.trace

    world.operations.status = DocumentOperationStatus.QUEUED
    assert cancel() is True

    world.operations.operation_error = RuntimeError("missing")
    assert cancel() is True


def test_submitted_work_runs_extraction_and_queued_cancel() -> None:
    world = World()
    started = start(world)

    world.trace.clear()
    assert world.work.run is not None
    world.work.run()
    assert world.trace[0] == ("document", PROJECT, started.document.id)
    assert world.trace[-1] == ("publish_review_ready", PROJECT, started.session.id)

    world.trace.clear()
    assert world.work.cancel_queued is not None
    world.work.cancel_queued()
    assert [item[0] for item in world.trace] == [
        "cancel",
        "acknowledge",
        "finish",
        "publish_terminal",
    ]


def test_queued_cancel_finishes_the_session_after_cancel_and_acknowledge() -> None:
    world = World()

    use_cases._cancel_queued_capture(
        world.sessions,
        world.operations,
        world.events,
        project_id=PROJECT,
        operation_id=OPERATION,
        session_id="session",
    )

    assert world.trace == [
        ("cancel", PROJECT, OPERATION),
        ("acknowledge", PROJECT, OPERATION),
        ("finish", PROJECT, "session", CaptureReviewStatus.CANCELED, None),
        ("publish_terminal", PROJECT, "session", CaptureReviewStatus.CANCELED),
    ]


def test_a_queued_cancel_finish_error_is_swallowed() -> None:
    world = World()
    world.sessions.finish_error = RuntimeError("no row")

    use_cases._cancel_queued_capture(
        world.sessions,
        world.operations,
        world.events,
        project_id=PROJECT,
        operation_id=OPERATION,
        session_id="session",
    )

    assert ("cancel", PROJECT, OPERATION) in world.trace
    assert ("acknowledge", PROJECT, OPERATION) in world.trace
    assert ("finish", PROJECT, "session", CaptureReviewStatus.CANCELED, None) in world.trace
    assert not any(item[0] == "publish_terminal" for item in world.trace)


def test_a_queued_cancel_error_still_finishes_the_session() -> None:
    world = World()
    world.operations.cancel_error = RuntimeError("busy")

    with pytest.raises(RuntimeError, match="busy"):
        use_cases._cancel_queued_capture(
            world.sessions,
            world.operations,
            world.events,
            project_id=PROJECT,
            operation_id=OPERATION,
            session_id="session",
        )

    assert ("acknowledge", PROJECT, OPERATION) not in world.trace
    assert ("finish", PROJECT, "session", CaptureReviewStatus.CANCELED, None) in world.trace
    assert ("publish_terminal", PROJECT, "session", CaptureReviewStatus.CANCELED) in world.trace


def test_a_queued_cancel_error_survives_a_finish_error() -> None:
    world = World()
    world.operations.cancel_error = RuntimeError("busy")
    world.sessions.finish_error = RuntimeError("no row")

    with pytest.raises(RuntimeError, match="busy"):
        use_cases._cancel_queued_capture(
            world.sessions,
            world.operations,
            world.events,
            project_id=PROJECT,
            operation_id=OPERATION,
            session_id="session",
        )

    assert not any(item[0] == "publish_terminal" for item in world.trace)


def test_an_acknowledge_error_still_finishes_a_canceled_capture() -> None:
    world = World()
    world.operations.acknowledge_error = RuntimeError("ack")

    with pytest.raises(RuntimeError, match="ack"):
        use_cases.finish_canceled_capture(
            world.sessions,
            world.operations,
            world.events,
            project_id=PROJECT,
            operation_id=OPERATION,
            session_id="session",
        )

    assert world.trace == [
        ("acknowledge", PROJECT, OPERATION),
        ("finish", PROJECT, "session", CaptureReviewStatus.CANCELED, None),
        ("publish_terminal", PROJECT, "session", CaptureReviewStatus.CANCELED),
    ]


def test_a_finish_error_after_a_failed_acknowledge_replaces_it() -> None:
    world = World()
    world.operations.acknowledge_error = RuntimeError("ack")
    world.sessions.finish_error = RuntimeError("no row")

    with pytest.raises(RuntimeError, match="no row"):
        use_cases.finish_canceled_capture(
            world.sessions,
            world.operations,
            world.events,
            project_id=PROJECT,
            operation_id=OPERATION,
            session_id="session",
        )

    assert ("finish", PROJECT, "session", CaptureReviewStatus.CANCELED, None) in world.trace
    assert not any(item[0] == "publish_terminal" for item in world.trace)


def test_expire_and_recover_each_call_only_their_maintenance_method() -> None:
    expiring = World()
    assert use_cases.expire_capture_reviews(expiring.maintenance) == ("session",)
    assert expiring.trace == [("expire",)]

    recovering = World()
    assert use_cases.recover_capture_reviews(recovering.maintenance) == ("session",)
    assert recovering.trace == [("recover",)]
